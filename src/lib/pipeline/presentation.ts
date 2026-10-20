import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnReviewItems,
    learnRuns,
    mailContents,
    mailPendingShares,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    users,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { getOrgUserId } from "@/lib/org/config";
import { processAgainPending } from "@/lib/pipeline/outdated";
import {
    type ProcessingRequestOrigin,
    processingStartedBy,
} from "@/lib/pipeline/processing-origin";
import type {
    PhaseName,
    PipelinePhases,
    SummaryStepName,
} from "@/lib/pipeline/types";
import { profileHistoryName } from "@/lib/profiles/history-name";
import { parseProfileSettings } from "@/lib/profiles/settings";
import { isRecordingShared } from "@/lib/sharing/shared";
import { recordingJobSubject } from "@/lib/sharing/view";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { waitingTaskDecisions } from "@/lib/tasks/waiting-review";
import { TOPICS_JOB_KIND } from "@/lib/topics/topics-job";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";

export interface ProcessingProfileSummary {
    id: string;
    name: string;
    scope: "personal" | "organization";
}

export interface ProcessingFolderSummary {
    id: string;
    parentId: string | null;
    name: string;
    path: string;
    scope: "personal" | "org";
}

export type ProcessingJobState = "queued" | "running";

export interface ProcessingPhaseFailure {
    phase: PhaseName;
    step?: SummaryStepName;
    reasonCode: string;
    retryAvailable: boolean;
}

export interface ItemProcessingPresentation {
    itemId: string;
    kind: "audio" | "mail";
    legacy: boolean;
    manualOnly: boolean;
    phases: PipelinePhases;
    profile:
        | (ProcessingProfileSummary & {
              revisionId: string;
              automatic: {
                  transcribe: boolean;
                  learn: boolean;
                  summary: boolean;
                  taskReview?: boolean;
              };
          })
        | null;
    placements: ProcessingFolderSummary[];
    intents: Array<
        Pick<ProcessingFolderSummary, "name" | "path"> & {
            folderId: string;
            confirmationRequired: boolean;
            confirmed: boolean;
        }
    >;
    outputs: {
        transcript: boolean;
        summary: boolean;
        learn: boolean;
    };
    processAgain: boolean;
    processAgainReason: "profile_changed" | null;
    learnFindingsWaiting: number;
    latestLearnRun?: {
        status:
            | "queued"
            | "running"
            | "ready"
            | "finished"
            | "failed"
            | "superseded"
            | "cancelled";
        errorCode: string | null;
        updatedAt: string;
    } | null;
    taskReviewWaiting: number;
    jobs: {
        transcription: ProcessingJobState | null;
        summary: ProcessingJobState | null;
    };
    startedBy?: ProcessingRequestOrigin;
    failures: ProcessingPhaseFailure[];
}

interface StoredFolder {
    id: string;
    userId: string;
    parentId: string | null;
    name: string;
}

/** Reduce active database jobs to the state shown for one pipeline phase. */
export function processingJobState(
    jobs: Array<{
        status: "pending" | "processing" | "completed" | "failed";
    }>,
): ProcessingJobState | null {
    if (jobs.some((job) => job.status === "processing")) return "running";
    return jobs.some((job) => job.status === "pending") ? "queued" : null;
}

/** Describe failed phase and Summary-step records for the status sentence. */
export function processingFailures(
    phases: PipelinePhases,
): ProcessingPhaseFailure[] {
    const failures: ProcessingPhaseFailure[] = [];
    const retryable = new Set<PhaseName>(["transcribe", "learn", "summary"]);
    for (const phase of [
        "categorize",
        "transcribe",
        "learn",
        "summary",
        "taskReview",
        "share",
    ] as const) {
        const record = phases[phase];
        if (record?.state === "failed") {
            failures.push({
                phase,
                reasonCode: record.reason ?? "UNKNOWN_FAILURE",
                retryAvailable: retryable.has(phase),
            });
        }
        if (phase !== "summary") continue;
        for (const step of ["title", "topics", "summary"] as const) {
            const recordStep = record?.steps?.[step];
            if (recordStep?.state !== "failed") continue;
            failures.push({
                phase,
                step,
                reasonCode: recordStep.reason ?? "UNKNOWN_FAILURE",
                retryAvailable: true,
            });
        }
    }
    return failures;
}

/** Identify the durable input change behind an explicit Process again state. */
export function processingOutdatedReason(
    phases: PipelinePhases,
): "profile_changed" | null {
    return processAgainPending(phases) ? "profile_changed" : null;
}

/** Count the task decisions shown by the review dialog for one item. */
export async function countItemTaskReviewWaiting(
    itemId: string,
    ownerUserId: string,
    orgUserId: string | null,
): Promise<number> {
    const shared = orgUserId
        ? await isRecordingShared(itemId, orgUserId)
        : false;
    const view = shared ? "org" : "private";
    return (await waitingTaskDecisions(db, itemId, ownerUserId, view)).total;
}

/** Present a settled task review while its durable phase catches up. */
export function settleTaskReviewPhase(
    phases: PipelinePhases,
    taskReviewWaiting: number,
    summaryCurrent: boolean,
): PipelinePhases {
    const taskReview = phases.taskReview;
    if (
        !summaryCurrent ||
        taskReviewWaiting !== 0 ||
        taskReview?.state !== "waiting"
    ) {
        return phases;
    }
    return {
        ...phases,
        taskReview: { ...taskReview, state: "done", reason: "reviewed" },
    };
}

async function folderPaths(
    ownerUserId: string,
    orgUserId: string | null,
    directFolders: StoredFolder[],
): Promise<Map<string, ProcessingFolderSummary>> {
    const rowsById = new Map(
        directFolders.map((folder) => [
            folder.id,
            { ...folder, name: decryptText(folder.name) },
        ]),
    );
    const allowedOwners = orgUserId
        ? [...new Set([ownerUserId, orgUserId])]
        : [ownerUserId];
    let parentIds = [
        ...new Set(
            directFolders.flatMap((folder) =>
                folder.parentId ? [folder.parentId] : [],
            ),
        ),
    ];
    while (parentIds.length > 0) {
        const parents = await db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
            })
            .from(recordingFolders)
            .where(
                and(
                    inArray(recordingFolders.id, parentIds),
                    inArray(recordingFolders.userId, allowedOwners),
                ),
            );
        parentIds = [];
        for (const parent of parents) {
            if (rowsById.has(parent.id)) continue;
            rowsById.set(parent.id, {
                ...parent,
                name: decryptText(parent.name),
            });
            if (parent.parentId) parentIds.push(parent.parentId);
        }
        parentIds = [...new Set(parentIds)];
    }

    return new Map(
        directFolders.map((folder) => {
            const parts: string[] = [];
            let current = rowsById.get(folder.id);
            const visited = new Set<string>();
            while (current && !visited.has(current.id)) {
                visited.add(current.id);
                parts.unshift(current.name);
                current = current.parentId
                    ? rowsById.get(current.parentId)
                    : undefined;
            }
            return [
                folder.id,
                {
                    id: folder.id,
                    parentId: folder.parentId,
                    name: decryptText(folder.name),
                    path: parts.join(" › "),
                    scope:
                        orgUserId && folder.userId === orgUserId
                            ? ("org" as const)
                            : ("personal" as const),
                },
            ];
        }),
    );
}

/** Build the owner-only private processing projection used by item headers. */
export async function loadPrivateItemProcessing(
    ownerUserId: string,
    itemId: string,
): Promise<ItemProcessingPresentation | null> {
    const [item] = await db
        .select({
            kind: chatterItems.kind,
            processingItemId: itemProcessing.itemId,
            manualOnly: itemProcessing.manualOnly,
            phases: itemProcessing.phases,
            profileId: processingProfiles.id,
            profileName: processingProfiles.name,
            profileDeletedAt: processingProfiles.deletedAt,
            viewerLocale: users.uiLocale,
            profileScope: processingProfiles.scope,
            profileRevisionId: processingProfileRevisions.id,
            profileSettings: processingProfileRevisions.settings,
        })
        .from(chatterItems)
        .leftJoin(users, eq(users.id, chatterItems.userId))
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, chatterItems.id),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .leftJoin(
            processingProfiles,
            eq(processingProfiles.id, itemProcessing.profileId),
        )
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    itemProcessing.profileRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return null;

    const [
        orgUserId,
        placementRows,
        intentRows,
        activeJobs,
        recentTranscriptionJobs,
        recentTopicsJobs,
        recentSummaryJobs,
        [learnFindings],
        transcripts,
        mailContent,
        summaries,
        learnRunRows,
    ] = await Promise.all([
        getOrgUserId(),
        db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, itemId),
                    eq(recordingFolderAssignments.userId, ownerUserId),
                ),
            ),
        db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
                confirmedAt: mailPendingShares.confirmedAt,
            })
            .from(mailPendingShares)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, mailPendingShares.folderId),
            )
            .where(
                and(
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, ownerUserId),
                ),
            ),
        db
            .select({ kind: asyncJobs.kind, status: asyncJobs.status })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, ownerUserId),
                    eq(
                        asyncJobs.subjectId,
                        recordingJobSubject(itemId, "private"),
                    ),
                    inArray(asyncJobs.kind, [
                        TRANSCRIPTION_JOB_KIND,
                        SUMMARY_JOB_KIND,
                        TOPICS_JOB_KIND,
                    ]),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            ),
        db
            .select({
                kind: asyncJobs.kind,
                payload: asyncJobs.payload,
                createdAt: asyncJobs.createdAt,
            })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, ownerUserId),
                    eq(
                        asyncJobs.subjectId,
                        recordingJobSubject(itemId, "private"),
                    ),
                    eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                ),
            )
            .orderBy(desc(asyncJobs.createdAt))
            .limit(1),
        db
            .select({
                kind: asyncJobs.kind,
                payload: asyncJobs.payload,
                createdAt: asyncJobs.createdAt,
            })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, ownerUserId),
                    eq(
                        asyncJobs.subjectId,
                        recordingJobSubject(itemId, "private"),
                    ),
                    eq(asyncJobs.kind, TOPICS_JOB_KIND),
                ),
            )
            .orderBy(desc(asyncJobs.createdAt))
            .limit(1),
        db
            .select({
                kind: asyncJobs.kind,
                payload: asyncJobs.payload,
                createdAt: asyncJobs.createdAt,
            })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, ownerUserId),
                    eq(
                        asyncJobs.subjectId,
                        recordingJobSubject(itemId, "private"),
                    ),
                    eq(asyncJobs.kind, SUMMARY_JOB_KIND),
                ),
            )
            .orderBy(desc(asyncJobs.createdAt))
            .limit(1),
        db
            .select({ count: count() })
            .from(learnReviewItems)
            .innerJoin(
                learnRuns,
                and(
                    eq(learnRuns.id, learnReviewItems.runId),
                    eq(learnRuns.userId, ownerUserId),
                ),
            )
            .where(
                and(
                    eq(learnRuns.itemId, itemId),
                    eq(learnRuns.userId, ownerUserId),
                    eq(learnRuns.view, "private"),
                    eq(learnRuns.status, "ready"),
                    eq(learnReviewItems.userId, ownerUserId),
                ),
            ),
        item.kind === "audio"
            ? db
                  .select({
                      id: transcriptions.id,
                      revision: transcriptions.revision,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, ownerUserId),
                          inArray(transcriptions.source, ["riffado", "plaud"]),
                      ),
                  )
            : Promise.resolve([]),
        item.kind === "mail"
            ? db
                  .select({
                      id: mailContents.id,
                      revision: mailContents.revision,
                  })
                  .from(mailContents)
                  .where(
                      and(
                          eq(mailContents.itemId, itemId),
                          eq(mailContents.userId, ownerUserId),
                      ),
                  )
                  .limit(1)
            : Promise.resolve([]),
        db
            .select({
                id: aiEnhancements.id,
                transcriptionId: aiEnhancements.transcriptionId,
                inputs: aiEnhancements.inputs,
            })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, itemId),
                    eq(aiEnhancements.userId, ownerUserId),
                    eq(aiEnhancements.source, "riffado"),
                    isNotNull(aiEnhancements.summary),
                ),
            ),
        db
            .select({
                transcriptionId: learnRuns.transcriptionId,
                transcriptRevision: learnRuns.transcriptRevision,
                inputs: learnRuns.inputs,
                status: learnRuns.status,
                errorCode: learnRuns.errorCode,
                createdAt: learnRuns.createdAt,
                updatedAt: learnRuns.updatedAt,
            })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, itemId),
                    eq(learnRuns.userId, ownerUserId),
                    eq(learnRuns.view, "private"),
                ),
            )
            .orderBy(desc(learnRuns.createdAt)),
    ]);
    const taskReviewWaiting = await countItemTaskReviewWaiting(
        itemId,
        ownerUserId,
        orgUserId,
    );
    const folderSummaries = await folderPaths(ownerUserId, orgUserId, [
        ...placementRows,
        ...intentRows,
    ]);
    const placements = placementRows.flatMap((folder) => {
        const summary = folderSummaries.get(folder.id);
        return summary ? [summary] : [];
    });
    const intents = intentRows.flatMap((folder) => {
        const summary = folderSummaries.get(folder.id);
        return summary
            ? [
                  {
                      folderId: summary.id,
                      name: summary.name,
                      path: summary.path,
                      confirmationRequired:
                          (item.manualOnly ?? false) &&
                          folder.confirmedAt === null,
                      confirmed: folder.confirmedAt !== null,
                  },
              ]
            : [];
    });
    const legacy =
        item.processingItemId === null ||
        item.phases?.categorize?.reason === "legacy";
    let automatic: {
        transcribe: boolean;
        learn: boolean;
        summary: boolean;
        title: boolean;
        topics: boolean;
        tasksEnabled: boolean;
    } | null = null;
    if (!legacy && item.profileSettings) {
        const storedSettings = JSON.parse(decryptText(item.profileSettings));
        if (item.kind === "audio") {
            const settings = parseProfileSettings("audio", storedSettings);
            automatic = {
                transcribe: settings.steps.transcribe.automatic,
                learn: settings.steps.learn.automatic,
                summary: settings.steps.summary.automatic,
                title: settings.steps.title.automatic,
                topics: settings.steps.topics.automatic,
                tasksEnabled: settings.steps.tasks.enabled,
            };
        } else {
            const settings = parseProfileSettings("mail", storedSettings);
            automatic = {
                transcribe: false,
                learn: settings.steps.learn.automatic,
                summary: settings.steps.summary.automatic,
                title: settings.steps.title.automatic,
                topics: false,
                tasksEnabled: settings.steps.tasks.enabled,
            };
        }
    }
    const profile =
        !legacy &&
        item.profileId &&
        item.profileName &&
        item.profileRevisionId &&
        item.profileScope &&
        automatic
            ? {
                  id: item.profileId,
                  name: profileHistoryName(
                      decryptText(item.profileName),
                      item.profileDeletedAt,
                      item.viewerLocale,
                  ),
                  scope: item.profileScope,
                  revisionId: item.profileRevisionId,
                  automatic: {
                      transcribe: automatic.transcribe,
                      learn: automatic.learn,
                      summary: automatic.summary,
                      taskReview: automatic.summary && automatic.tasksEnabled,
                  },
              }
            : null;
    const learnDone = learnRunRows.some((run) => {
        if (run.status !== "finished") return false;
        const inputs = run.inputs as {
            contentId?: unknown;
            contentRevision?: unknown;
        } | null;
        if (item.kind === "mail") {
            const content = mailContent[0];
            return (
                content !== undefined &&
                run.transcriptionId === null &&
                run.transcriptRevision === content.revision &&
                inputs?.contentId === content.id &&
                inputs.contentRevision === content.revision
            );
        }
        const transcript = transcripts.find(
            (candidate) => candidate.id === run.transcriptionId,
        );
        return (
            transcript !== undefined &&
            run.transcriptRevision === transcript.revision &&
            inputs?.contentId === transcript.id &&
            inputs.contentRevision === transcript.revision
        );
    });
    const summaryCurrent = summaries.some((summary) => {
        const inputs = summary.inputs as {
            contentId?: unknown;
            contentRevision?: unknown;
        } | null;
        if (item.kind === "mail") {
            const content = mailContent[0];
            return (
                content !== undefined &&
                inputs?.contentId === content.id &&
                inputs.contentRevision === content.revision
            );
        }
        const transcript = transcripts.find(
            (candidate) => candidate.id === summary.transcriptionId,
        );
        return (
            transcript !== undefined &&
            (inputs?.contentRevision === undefined ||
                inputs.contentRevision === transcript.revision)
        );
    });

    const phases = settleTaskReviewPhase(
        item.phases ?? {},
        taskReviewWaiting,
        summaryCurrent,
    );
    const processAgain =
        !legacy &&
        !(item.manualOnly ?? false) &&
        automatic !== null &&
        Object.values(automatic).some(Boolean) &&
        processAgainPending(item.phases ?? {});
    const transcriptionJobs = activeJobs.filter(
        (job) => job.kind === TRANSCRIPTION_JOB_KIND,
    );
    const summaryJobs = activeJobs.filter((job) =>
        [SUMMARY_JOB_KIND, TOPICS_JOB_KIND].includes(job.kind),
    );

    return {
        itemId,
        kind: item.kind,
        legacy,
        manualOnly: item.manualOnly ?? false,
        phases,
        profile,
        placements,
        intents,
        outputs: {
            transcript: transcripts.length > 0,
            summary: summaryCurrent,
            learn: learnDone,
        },
        processAgain,
        processAgainReason: processAgain
            ? processingOutdatedReason(item.phases ?? {})
            : null,
        learnFindingsWaiting: learnFindings?.count ?? 0,
        latestLearnRun: learnRunRows[0]
            ? {
                  status: learnRunRows[0].status,
                  errorCode: learnRunRows[0].errorCode,
                  updatedAt: learnRunRows[0].updatedAt.toISOString(),
              }
            : null,
        taskReviewWaiting,
        jobs: {
            transcription: processingJobState(transcriptionJobs),
            summary: processingJobState(summaryJobs),
        },
        startedBy: processingStartedBy(
            [
                ...recentTranscriptionJobs,
                ...recentSummaryJobs,
                ...recentTopicsJobs,
            ],
            {
                transcription: TRANSCRIPTION_JOB_KIND,
                summary: SUMMARY_JOB_KIND,
                topics: TOPICS_JOB_KIND,
            },
        ),
        failures: processingFailures(phases),
    };
}
