import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    itemTaskRowsVersion,
    itemTitleVersion,
    loadTranscriptOverlayVersions,
    summaryRemarksVersion,
    transcriptPartVersion,
    transcriptTopicsVersion,
} from "@/db/queries/item-content-versions";
import { loadPipelineProcessingJobs } from "@/db/queries/pipeline-processing";
import {
    placementVisibleCondition,
    restrictedFolderVisibleCondition,
    restrictedMemberCondition,
} from "@/db/queries/restricted-folders";
import { readOwnerTrimProposal } from "@/db/queries/trim-proposal";
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
    recordings,
    transcriptions,
    users,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { AppError } from "@/lib/errors";
import { folderDisplayName, folderDisplayPath } from "@/lib/folders/labels";
import {
    type AppLocale,
    localeFromAcceptLanguage,
    normalizeLocale,
} from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { learnRunCurrentScope } from "@/lib/learn/learn-open";
import { needsLearnReview } from "@/lib/learn/review-policy";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { pipelineDriver } from "@/lib/pipeline/driver";
import { effectiveManualOnly } from "@/lib/pipeline/effective-profile";
import { processAgainPending } from "@/lib/pipeline/outdated";
import {
    type ProcessingRequestOrigin,
    processingStartedBy,
} from "@/lib/pipeline/processing-origin";
import {
    type ProcessingStep,
    projectProcessing,
} from "@/lib/pipeline/processing-status";
import {
    audioHasPriorOutput,
    plaudTranscriptInput,
    plaudTranscriptTurns,
    sharedTranscriptionReadOnly,
} from "@/lib/pipeline/transcript-facts";
import { canUsePlaudTranscript } from "@/lib/pipeline/transcript-policy";
import type {
    PhaseName,
    PipelinePhases,
    PipelineProfileFacts,
    SummaryStepName,
} from "@/lib/pipeline/types";
import { profileHistoryName } from "@/lib/profiles/history-name";
import { parseProfileSettings } from "@/lib/profiles/settings";
import { resolveRecordingLanguageProfile } from "@/lib/recordings/language-metadata";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";
import { requestedRecordingView } from "@/lib/sharing/access";
import { isRecordingShared, sharedItemCondition } from "@/lib/sharing/shared";
import { type RecordingView, recordingJobSubject } from "@/lib/sharing/view";
import { assertMayChange } from "@/lib/sharing/writer";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { waitingTaskDecisions } from "@/lib/tasks/waiting-review";
import { TOPICS_JOB_KIND } from "@/lib/topics/topics-job";
import {
    preferredTranscript,
    TRANSCRIPT_SOURCE_ORDER,
} from "@/lib/transcription/preferred-source";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";
import type { FolderKind } from "@/types/folder";

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
    restricted?: true;
    access?: boolean;
}

export type ProcessingJobState = "queued" | "running";

export interface ProcessingPhaseFailure {
    phase: PhaseName;
    step?: SummaryStepName;
    reasonCode: string;
    retryAvailable: boolean;
}

export interface ItemProcessingPresentation {
    access?: ItemProcessingAccess;
    versions?: ItemProcessingVersions;
    trimProposal?: StoredTrimProposal | null;
    itemId: string;
    kind: "audio" | "mail";
    legacy: boolean;
    manualOnly: boolean;
    phases: PipelinePhases;
    steps: Record<Exclude<PhaseName, "trim">, ProcessingStep>;
    nextCheckAt: string;
    nextCheckInMs: number;
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
    failedLearnRunId?: string;
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
        topics?: ProcessingJobState | null;
        title?: ProcessingJobState | null;
    };
    startedBy?: ProcessingRequestOrigin;
    failures: ProcessingPhaseFailure[];
}

interface ItemProcessingAccess {
    shared: boolean;
    role: "owner" | "curator" | "member";
    contentView: "private" | "org";
}

interface ItemProcessingVersions {
    item: string;
    folders: string;
    tasks: string;
    title: string;
    content?: string;
    transcripts: Record<string, string>;
    summaries: Record<string, string>;
    learn: Record<string, string>;
    corrections: Record<string, string>;
    speakers: Record<string, string>;
    language?: string;
}

type LoadedItemProcessing = ItemProcessingPresentation & {
    access: ItemProcessingAccess;
    versions: ItemProcessingVersions;
};

function version(...values: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function learnRunVersion(run: {
    id: string;
    status: string;
    updatedAt: Date;
    transcriptRevision: number | null;
}): string {
    return version(run.id, run.status, run.updatedAt, run.transcriptRevision);
}

function viewerRole(
    isOwner: boolean,
    viewerUserId: string,
    orgUserId: string | null,
): ItemProcessingAccess["role"] {
    if (isOwner) return "owner";
    if (viewerUserId === orgUserId) return "curator";
    return "member";
}

function canReadLearnReview(
    ownerUserId: string,
    viewerUserId: string,
    orgUserId: string | null,
    shared: boolean,
    view: "private" | "org",
    curates: boolean,
) {
    try {
        assertMayChange(
            { ownerUserId, orgUserId, shared, view },
            viewerUserId,
            curates,
        );
        return true;
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 403) return false;
        throw error;
    }
}

interface StoredFolder {
    kind: FolderKind;
    id: string;
    userId: string;
    parentId: string | null;
    name: string;
    restricted?: boolean;
    access?: boolean;
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
                retryAvailable:
                    record.reason === "lost" || retryable.has(phase),
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
    locale: AppLocale,
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
                kind: recordingFolders.kind,
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

    const labels = {
        private: translatedSourceMessage(locale, "Private"),
        organization: translatedSourceMessage(locale, "Organization"),
    };
    const scope = (folder: StoredFolder) =>
        orgUserId && folder.userId === orgUserId
            ? ("org" as const)
            : ("personal" as const);
    const label = (folder: StoredFolder) =>
        folderDisplayName(
            {
                ...folder,
                restricted: folder.restricted ? true : undefined,
                scope: scope(folder),
            },
            labels,
        );
    return new Map(
        directFolders.map((folder) => {
            const displayFolder = { ...folder, name: decryptText(folder.name) };
            return [
                folder.id,
                {
                    id: folder.id,
                    parentId: folder.parentId,
                    name: label(displayFolder),
                    path: folderDisplayPath(
                        displayFolder,
                        rowsById,
                        label,
                        " › ",
                    ),
                    scope: scope(folder),
                    ...(folder.restricted
                        ? { restricted: true as const, access: folder.access }
                        : {}),
                },
            ];
        }),
    );
}

/** Build the owner-scoped processing projection with labels localized for its viewer. */
export async function loadPrivateItemProcessing(
    ownerUserId: string,
    itemId: string,
    viewerUserId = ownerUserId,
    fallbackLocale: AppLocale = "en",
    view: RecordingView = "private",
    allowPrivateFallback = false,
): Promise<LoadedItemProcessing | null> {
    const isOwner = viewerUserId === ownerUserId;
    if (view === "received") {
        if (!allowPrivateFallback || !isOwner) return null;
        view = "private";
    }
    if (view === "private" && !isOwner) return null;
    const orgUserId = await getOrgUserId();
    const shared = orgUserId ? sharedItemCondition(orgUserId) : sql`false`;
    const contentScope = sql`case when ${shared} then 'org' else 'private' end`;
    const driver = pipelineDriver(ownerUserId);
    const [item] = await db
        .select({
            kind: chatterItems.kind,
            shared: sql<boolean>`${shared}`,
            summaryDueAt: chatterItems.summaryDueAt,
            audioReapedAt: recordings.audioReapedAt,
            contentReapedAt: chatterItems.contentReapedAt,
            hasPriorOutput: audioHasPriorOutput(db, ownerUserId, itemId),
            title: itemTitleVersion(),
            titleEditedAt: chatterItems.titleEditedAt,
            confirmedLanguage: recordings.confirmedLanguage,
            taskRowsVersion: itemTaskRowsVersion(isOwner, contentScope),
            processingItemId: itemProcessing.itemId,
            requestedGeneration: itemProcessing.requestedGeneration,
            processedGeneration: itemProcessing.processedGeneration,
            taskReviewChangedAt: itemProcessing.taskReviewChangedAt,
            taskReviewSkippedAt: itemProcessing.taskReviewSkippedAt,
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
        .leftJoin(
            recordings,
            and(
                eq(recordings.id, chatterItems.id),
                eq(recordings.userId, ownerUserId),
            ),
        )
        .leftJoin(users, eq(users.id, viewerUserId))
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, chatterItems.id),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, driver.view),
            ),
        )
        .leftJoin(
            processingProfiles,
            eq(
                processingProfiles.id,
                sql<string>`coalesce(${itemProcessing.phases}->'categorize'->'placementProfile'->>'profileId', ${itemProcessing.profileId})`,
            ),
        )
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    sql<string>`coalesce(${itemProcessing.phases}->'categorize'->'placementProfile'->>'profileRevisionId', ${itemProcessing.profileRevisionId})`,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
                view === "org" && !(allowPrivateFallback && isOwner)
                    ? shared
                    : undefined,
            ),
        )
        .limit(1);
    if (!item || item.kind === "meeting") return null;
    if (!item.shared) view = "private";
    const contentView = item.shared ? "org" : view;
    const canReadRemarks =
        isOwner &&
        viewerUserId !== orgUserId &&
        (!item.shared || isOrgScopeEnabled());

    const restrictedViewer = {
        userId: viewerUserId,
        isCurator: await userCuratesOrganizationNow(viewerUserId),
    };
    const canReadLearn = canReadLearnReview(
        ownerUserId,
        viewerUserId,
        orgUserId,
        item.shared,
        contentView,
        restrictedViewer.isCurator,
    );
    const [
        placementRows,
        intentRows,
        processingJobs,
        recentTranscriptionJobs,
        recentTopicsJobs,
        recentSummaryJobs,
        nonSpeakerFindings,
        speakerFindings,
        transcripts,
        mailContent,
        summaries,
        learnRunRows,
        [taskReviewMarkers],
        languageProfile,
    ] = await Promise.all([
        db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
                kind: recordingFolders.kind,
                withheld: recordingFolderAssignments.withheld,
                restricted: sql<boolean>`${recordingFolders.restrictedAt} is not null or ${recordingFolders.restrictingAt} is not null`,
                access: sql<boolean>`${placementVisibleCondition(restrictedViewer)}`,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    viewerUserId === ownerUserId
                        ? undefined
                        : and(
                              placementVisibleCondition(restrictedViewer),
                              orgUserId
                                  ? eq(recordingFolders.userId, orgUserId)
                                  : sql`false`,
                          ),
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
                kind: recordingFolders.kind,
                confirmedAt: mailPendingShares.confirmedAt,
            })
            .from(mailPendingShares)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, mailPendingShares.folderId),
            )
            .where(
                and(
                    restrictedFolderVisibleCondition(restrictedViewer),
                    restrictedViewer.isCurator
                        ? undefined
                        : sql`(not exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.folderId} = ${mailPendingShares.folderId} and ${recordingFolderAssignments.itemId} = ${mailPendingShares.itemId} and ${recordingFolderAssignments.withheld}) or ${restrictedMemberCondition(viewerUserId)})`,
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, ownerUserId),
                ),
            ),
        loadPipelineProcessingJobs(ownerUserId, itemId, item.phases ?? {}),
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
            .select({
                n: count(),
            })
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
                    learnRunCurrentScope(orgUserId),
                    eq(learnRuns.view, contentView),
                    eq(learnRuns.status, "ready"),
                    eq(learnReviewItems.userId, learnRuns.scopeUserId),
                    ne(learnReviewItems.kind, "known_fact"),
                    ne(learnReviewItems.kind, "speaker"),
                ),
            ),
        db
            .select({
                kind: learnReviewItems.kind,
                payload: learnReviewItems.payload,
            })
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
                    learnRunCurrentScope(orgUserId),
                    eq(learnRuns.view, contentView),
                    eq(learnRuns.status, "ready"),
                    eq(learnReviewItems.userId, learnRuns.scopeUserId),
                    eq(learnReviewItems.kind, "speaker"),
                ),
            ),
        item.kind === "audio"
            ? db
                  .select({
                      id: transcriptions.id,
                      revision: transcriptions.revision,
                      source: transcriptions.source,
                      topics: transcriptTopicsVersion(),
                      turns: plaudTranscriptTurns,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, ownerUserId),
                          inArray(transcriptions.source, [
                              ...TRANSCRIPT_SOURCE_ORDER,
                          ]),
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
                source: aiEnhancements.source,
                transcriptionId: aiEnhancements.transcriptionId,
                inputs: aiEnhancements.inputs,
                hasSummary: sql<boolean>`${aiEnhancements.summary} is not null`,
                revision: aiEnhancements.revision,
                editedAt: aiEnhancements.editedAt,
                inputFingerprint: aiEnhancements.inputFingerprint,
                remarks: canReadRemarks
                    ? summaryRemarksVersion()
                    : sql<null>`null`,
            })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, itemId),
                    eq(aiEnhancements.userId, ownerUserId),
                ),
            )
            .orderBy(aiEnhancements.source),
        db
            .select({
                id: learnRuns.id,
                view: learnRuns.view,
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
                    learnRunCurrentScope(orgUserId),
                    eq(learnRuns.view, contentView),
                ),
            )
            .orderBy(desc(learnRuns.createdAt), desc(learnRuns.id)),
        isOwner && driver.view !== contentView
            ? db
                  .select({
                      changed: itemProcessing.taskReviewChangedAt,
                      skipped: itemProcessing.taskReviewSkippedAt,
                  })
                  .from(itemProcessing)
                  .where(
                      and(
                          eq(itemProcessing.itemId, itemId),
                          eq(itemProcessing.userId, ownerUserId),
                          eq(itemProcessing.view, contentView),
                      ),
                  )
                  .limit(1)
            : Promise.resolve(
                  isOwner
                      ? [
                            {
                                changed: item.taskReviewChangedAt,
                                skipped: item.taskReviewSkippedAt,
                            },
                        ]
                      : [],
              ),
        item.kind === "audio"
            ? resolveRecordingLanguageProfile(
                  itemId,
                  contentView,
                  ownerUserId,
                  viewerUserId,
              )
            : Promise.resolve(null),
    ]);
    const canReviewTasks = viewerUserId === ownerUserId;
    const [taskReviewWaiting, folderSummaries, overlays] = await Promise.all([
        canReviewTasks && !taskReviewMarkers?.skipped
            ? waitingTaskDecisions(
                  db,
                  itemId,
                  ownerUserId,
                  contentView,
                  true,
              ).then(({ total }) => total)
            : 0,
        folderPaths(
            ownerUserId,
            orgUserId,
            [...placementRows, ...intentRows],
            normalizeLocale(item.viewerLocale) ?? fallbackLocale,
        ),
        loadTranscriptOverlayVersions(
            ownerUserId,
            transcripts.map((row) => row.id),
            item.shared,
            isOwner || restrictedViewer.isCurator,
        ),
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
                          effectiveManualOnly(item) &&
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
    let transcriptionPolicy: PipelineProfileFacts["transcribe"];
    if (!legacy && item.profileSettings) {
        const storedSettings = JSON.parse(decryptText(item.profileSettings));
        if (item.kind === "audio") {
            const settings = parseProfileSettings("audio", storedSettings);
            transcriptionPolicy = settings.steps.transcribe;
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
        if (summary.source !== "riffado" || !summary.hasSummary) return false;
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

    let phases = settleTaskReviewPhase(
        item.phases ?? {},
        taskReviewWaiting,
        summaryCurrent,
    );
    if (!canReviewTasks && phases.taskReview) {
        phases = { ...phases };
        delete phases.taskReview;
    }
    const processAgain =
        !legacy &&
        !effectiveManualOnly(item) &&
        automatic !== null &&
        Object.values(automatic).some(Boolean) &&
        processAgainPending(item.phases ?? {});
    const ownerTrim =
        viewerUserId === ownerUserId &&
        view === "private" &&
        item.kind === "audio";
    const preferred = ownerTrim ? preferredTranscript(transcripts) : undefined;
    const currentPrivateLearn = preferred
        ? learnRunRows.find(
              (run) =>
                  run.view === "private" &&
                  run.transcriptionId === preferred.id &&
                  run.transcriptRevision === preferred.revision,
          )
        : undefined;
    const trimProposal =
        ownerTrim &&
        phases.trim?.state === "waiting" &&
        phases.trim.waitingFor?.kind === "trimReview"
            ? await readOwnerTrimProposal(ownerUserId, itemId)
            : null;
    if (
        ownerTrim &&
        !trimProposal &&
        phases.trim?.state === "waiting" &&
        phases.trim.waitingFor?.kind === "trimReview"
    ) {
        const [current] = await db
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, ownerUserId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .limit(1);
        if (current) phases = { ...phases, trim: current.phases.trim };
    }
    const learn: Record<string, string> = {};
    const content = mailContent[0];
    if (canReadLearn && item.kind === "mail") {
        const run = learnRunRows.find((run) => run.transcriptionId === null);
        if (run) learn.mail = learnRunVersion(run);
    }
    const transcriptVersions: Record<string, string> = {};
    const correctionVersions: Record<string, string> = {};
    const speakerVersions: Record<string, string> = {};
    // Sorted so the item hash does not depend on the database's row order.
    for (const transcript of [...transcripts].sort((a, b) =>
        a.source.localeCompare(b.source),
    )) {
        const { source, id, revision, topics } = transcript;
        transcriptVersions[source] = transcriptPartVersion(
            id,
            revision,
            topics,
        );
        const corrections = overlays.corrections.find((row) => row.id === id);
        correctionVersions[source] = version(
            id,
            revision,
            corrections?.count ?? 0,
            corrections?.updatedAt,
        );
        const speakers = overlays.speakers.find((row) => row.id === id);
        speakerVersions[source] = version(
            id,
            revision,
            speakers?.count ?? 0,
            speakers?.updatedAt,
        );
        const run =
            canReadLearn &&
            learnRunRows.find(
                (row) =>
                    row.transcriptionId === id &&
                    row.transcriptRevision === revision,
            );
        if (run) learn[source] = learnRunVersion(run);
    }
    const preferredContent = preferredTranscript(transcripts);
    const hasPipelineTranscript =
        preferredContent?.source === "plaud" &&
        transcriptionPolicy?.plaudTranscript === "use"
            ? canUsePlaudTranscript({
                  transcript: plaudTranscriptInput(preferredContent),
                  policy: transcriptionPolicy,
                  phases,
                  manualOnly: effectiveManualOnly(item),
                  transcriptionBlocked:
                      item.audioReapedAt != null ||
                      item.contentReapedAt != null ||
                      sharedTranscriptionReadOnly(item.shared),
                  hasPriorOutput: item.hasPriorOutput,
              })
            : preferredContent !== undefined;
    const olderContentInputOf = (row: (typeof summaries)[number]) => {
        if (
            typeof row.inputs?.contentId !== "string" ||
            typeof row.inputs.contentRevision !== "number"
        )
            return undefined;
        const source = row.inputs.contentSourceId;
        if (source === "mail") return content;
        if (source !== "riffado" && source !== "plaud") return undefined;
        if (row.editedAt) return preferredContent;
        return transcripts.find((transcript) => transcript.source === source);
    };
    const summaryVersions = Object.fromEntries(
        summaries.map((row) => {
            const olderContentInput = olderContentInputOf(row);
            const staleInput = row.inputFingerprint
                ? transcripts.find(
                      (transcript) => transcript.id === row.transcriptionId,
                  )
                : undefined;
            return [
                row.source,
                version(
                    row.id,
                    row.revision,
                    row.editedAt,
                    row.source === "riffado" ? row.remarks : null,
                    olderContentInput?.id,
                    olderContentInput?.revision,
                    staleInput && correctionVersions[staleInput.source],
                ),
            ];
        }),
    );
    const partVersions = {
        folders: version(
            [...placementRows]
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(({ id, parentId, withheld, restricted, access }) => [
                    id,
                    parentId,
                    withheld,
                    restricted,
                    access,
                ]),
            [...intentRows]
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(({ id, confirmedAt }) => [
                    id,
                    confirmedAt,
                    effectiveManualOnly(item),
                ]),
        ),
        tasks: version(
            taskReviewWaiting,
            taskReviewMarkers?.changed ?? null,
            taskReviewMarkers?.skipped ?? null,
            item.taskRowsVersion,
        ),
        title: item.title,
        ...(content ? { content: version(content.id, content.revision) } : {}),
        transcripts: transcriptVersions,
        summaries: summaryVersions,
        learn,
        corrections: correctionVersions,
        speakers: speakerVersions,
        ...(item.kind === "audio"
            ? {
                  language: version(
                      item.confirmedLanguage,
                      item.title,
                      item.titleEditedAt,
                      summaries.map(({ id, revision, editedAt }) => [
                          id,
                          revision,
                          editedAt,
                      ]),
                      languageProfile?.revisionId,
                  ),
              }
            : {}),
    };
    const presentation: Omit<
        LoadedItemProcessing,
        "steps" | "nextCheckAt" | "nextCheckInMs"
    > = {
        access: {
            role: viewerRole(isOwner, viewerUserId, orgUserId),
            shared: item.shared === true,
            contentView,
        },
        versions: {
            ...partVersions,
            item: version(
                partVersions,
                item.requestedGeneration ?? 0,
                item.processedGeneration ?? 0,
            ),
        },
        ...(ownerTrim ? { trimProposal } : {}),
        itemId,
        kind: item.kind,
        legacy,
        manualOnly: effectiveManualOnly(item),
        phases,
        profile,
        placements,
        intents,
        outputs: {
            transcript: transcripts.length > 0,
            summary: summaries.some(({ hasSummary }) => hasSummary),
            learn: learnDone,
        },
        processAgain,
        processAgainReason: processAgain
            ? processingOutdatedReason(item.phases ?? {})
            : null,
        learnFindingsWaiting:
            (nonSpeakerFindings[0]?.n ?? 0) +
            speakerFindings.filter((item) =>
                needsLearnReview({
                    ...item,
                    payload: decryptJsonField(item.payload),
                }),
            ).length,
        latestLearnRun: learnRunRows[0]
            ? {
                  status: learnRunRows[0].status,
                  errorCode: learnRunRows[0].errorCode,
                  updatedAt: learnRunRows[0].updatedAt.toISOString(),
              }
            : null,
        ...(currentPrivateLearn?.status === "failed"
            ? { failedLearnRunId: currentPrivateLearn.id }
            : {}),
        taskReviewWaiting,
        jobs: { transcription: null, summary: null, topics: null, title: null },
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
    const projected = projectProcessing(presentation, processingJobs, {
        hasEligibleTranscript: hasPipelineTranscript,
        advancePending:
            (item.processedGeneration ?? 0) < (item.requestedGeneration ?? 0),
        canChange:
            (isOwner || restrictedViewer.isCurator) &&
            (!placementRows.some((folder) => folder.userId === orgUserId) ||
                isOrgScopeEnabled()),
        canFile: viewerUserId === ownerUserId && view === "private",
        canProcessAgain: viewerUserId === ownerUserId,
        reviewUntil: item.summaryDueAt?.toISOString(),
    });
    return {
        ...projected,
        access: presentation.access,
        versions: presentation.versions,
    };
}

/** Load the committed state in the requested view, with the owner's private fallback. */
export async function loadFolderWriteProcessing(
    request: Request,
    ownerUserId: string,
    itemId: string,
    viewerUserId: string,
) {
    try {
        return {
            processing: await loadPrivateItemProcessing(
                ownerUserId,
                itemId,
                viewerUserId,
                localeFromAcceptLanguage(
                    request.headers.get("accept-language"),
                ),
                requestedRecordingView(request),
                true,
            ),
        };
    } catch (error) {
        console.error(
            "[processing] Could not load the projection after a folder write",
            error instanceof AppError ? error.code : undefined,
        );
        return { processingStale: true as const };
    }
}
