import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    chatterItems,
    learnRuns,
    mailContents,
    mailMessages,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskUpdateProposals,
    transcriptions,
    users,
} from "@/db/schema";
import { pickEnhancementCredential } from "@/lib/ai/enhancement-provider";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { learnRunOpen } from "@/lib/learn/learn-open";
import { isSummaryStale } from "@/lib/learn/summary-refresh";
import { mailShareProblems } from "@/lib/mail/share-gate";
import { readProcessing } from "@/lib/pipeline/state";
import type {
    PhaseRecord,
    PipelineFacts,
    PipelinePhases,
    PipelineView,
} from "@/lib/pipeline/types";
import { resolveStepProvider } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";
import { loadShareGate } from "@/lib/sharing/load-share-gate";
import { recordingJobSubject } from "@/lib/sharing/view";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";

async function readShared(itemId: string, userId: string): Promise<boolean> {
    const [row] = await db
        .select({ itemId: recordingFolderAssignments.itemId })
        .from(recordingFolderAssignments)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingFolderAssignments.itemId),
                eq(chatterItems.userId, userId),
            ),
        )
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .innerJoin(
            users,
            and(eq(users.id, recordingFolders.userId), eq(users.role, "org")),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, itemId),
                eq(recordingFolderAssignments.userId, userId),
                eq(chatterItems.userId, userId),
            ),
        )
        .limit(1);
    return row !== undefined;
}

function legacyPhases(input: {
    kind: "audio" | "mail";
    hasPlacement: boolean;
    content: { id: string; revision: number } | null;
}): PipelinePhases {
    const at = new Date().toISOString();
    const phases: PipelinePhases = {
        categorize: {
            state: input.hasPlacement ? "done" : "skipped",
            reason: "legacy",
            generation: 0,
            at,
        },
    };
    if (!input.content) return phases;

    const contentInput = {
        contentId: input.content.id,
        contentSourceId: input.kind === "audio" ? "riffado" : "mail",
        contentRevision: input.content.revision,
    };
    const summarySteps: NonNullable<PhaseRecord["steps"]> = {};
    const stepNames =
        input.kind === "audio"
            ? (["title", "topics", "summary"] as const)
            : (["title", "summary"] as const);
    for (const step of stepNames) {
        summarySteps[step] = {
            contentId: contentInput.contentId,
            contentRevision: contentInput.contentRevision,
            generation: 0,
        };
    }
    phases.learn = {
        state: "done",
        reason: "legacy",
        generation: 0,
        inputs: contentInput,
        at,
    };
    phases.summary = {
        state: "done",
        reason: "legacy",
        generation: 0,
        inputs: contentInput,
        steps: summarySteps,
        at,
    };
    return phases;
}

/** Read the durable, owner-scoped facts consumed by the Stage 1 planner. */
export async function gatherFacts(
    itemId: string,
    view: PipelineView,
    userId: string,
): Promise<PipelineFacts> {
    const [processing, [item], credentials] = await Promise.all([
        readProcessing(itemId, view, userId),
        db
            .select({
                kind: chatterItems.kind,
                deletedAt: chatterItems.deletedAt,
                contentReapedAt: chatterItems.contentReapedAt,
                summaryDueAt: chatterItems.summaryDueAt,
            })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, userId),
                ),
            )
            .limit(1),
        db
            .select({
                provider: apiCredentials.provider,
                isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
                disabledAt: apiCredentials.disabledAt,
            })
            .from(apiCredentials)
            .where(eq(apiCredentials.userId, userId)),
    ]);

    const missing = !item;
    if (missing) {
        return {
            item: {
                exists: false,
                deleted: false,
                kind: "audio",
                ownerUserId: userId,
            },
            view,
            generation: processing?.requestedGeneration ?? 0,
            content: null,
            transcription: undefined,
            summaryDueAt: null,
            profile: null,
            categorization: {
                placementFolderIds: [],
                intendedFolderIds: [],
                profileAssigned: false,
                resolution: null,
            },
            hasEnhancementCredential: Boolean(
                pickEnhancementCredential(credentials),
            ),
            learnAvailability: isLearnDeploymentAvailable()
                ? "no_provider"
                : "hosted",
            learnRunOpen: false,
            mail: null,
            summary: { exists: false, stale: false, jobActive: false },
            taskReview: { proposals: 0, followUps: 0 },
            share: { problems: [] },
            phases: processing?.phases ?? {},
            at: new Date().toISOString(),
        };
    }

    const contentPromise: Promise<{
        id: string;
        revision: number;
        timed: boolean;
    } | null> =
        item.kind === "audio"
            ? db
                  .select({
                      id: transcriptions.id,
                      revision: transcriptions.revision,
                      turns: transcriptions.turns,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, userId),
                          eq(transcriptions.source, "riffado"),
                      ),
                  )
                  .limit(1)
                  .then(([row]) =>
                      row
                          ? {
                                id: row.id,
                                revision: row.revision,
                                timed: row.turns !== null,
                            }
                          : null,
                  )
            : db
                  .select({
                      id: mailContents.id,
                      revision: mailContents.revision,
                  })
                  .from(mailContents)
                  .where(
                      and(
                          eq(mailContents.itemId, itemId),
                          eq(mailContents.userId, userId),
                      ),
                  )
                  .limit(1)
                  .then(([row]) =>
                      row
                          ? {
                                id: row.id,
                                revision: row.revision,
                                timed: false,
                            }
                          : null,
                  );
    const mailPromise =
        item.kind === "mail"
            ? db
                  .select({
                      autoGenerated: mailMessages.autoGenerated,
                      unreadable: mailMessages.unreadable,
                  })
                  .from(mailMessages)
                  .where(
                      and(
                          eq(mailMessages.id, itemId),
                          eq(mailMessages.userId, userId),
                      ),
                  )
                  .limit(1)
            : Promise.resolve([]);
    const plaudTranscriptPromise =
        item.kind === "audio"
            ? db
                  .select({
                      id: transcriptions.id,
                      revision: transcriptions.revision,
                      turns: transcriptions.turns,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, userId),
                          eq(transcriptions.source, "plaud"),
                      ),
                  )
                  .limit(1)
                  .then(([row]) =>
                      row
                          ? {
                                id: row.id,
                                revision: row.revision,
                                timed: row.turns !== null,
                            }
                          : null,
                  )
            : Promise.resolve(null);
    const [
        content,
        [mail],
        [summary],
        [summaryJob],
        shared,
        placements,
        intents,
        proposals,
        followUps,
        plaudTranscript,
        [transcriptionJob],
        [failedTranscriptionJob],
        [recording],
        [openLearnRun],
    ] = await Promise.all([
        contentPromise,
        mailPromise,
        db
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, itemId),
                    eq(aiEnhancements.userId, userId),
                    eq(aiEnhancements.source, "riffado"),
                ),
            )
            .limit(1),
        db
            .select({ id: asyncJobs.id })
            .from(asyncJobs)
            .where(
                and(
                    eq(asyncJobs.userId, userId),
                    eq(asyncJobs.kind, SUMMARY_JOB_KIND),
                    eq(asyncJobs.subjectId, recordingJobSubject(itemId, view)),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            )
            .limit(1),
        readShared(itemId, userId),
        db
            .select({ folderId: recordingFolderAssignments.folderId })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, itemId),
                    eq(recordingFolderAssignments.userId, userId),
                    isNotNull(recordingFolders.parentId),
                ),
            ),
        db
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, userId),
                ),
            ),
        db
            .select({ id: recordingTasks.id })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, itemId),
                    eq(recordingTasks.userId, userId),
                    eq(recordingTasks.status, "proposed"),
                ),
            ),
        db
            .select({ id: taskUpdateProposals.id })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.itemId, itemId),
                    eq(taskUpdateProposals.userId, userId),
                ),
            ),
        plaudTranscriptPromise,
        item.kind === "audio"
            ? db
                  .select({ id: asyncJobs.id })
                  .from(asyncJobs)
                  .where(
                      and(
                          eq(asyncJobs.userId, userId),
                          eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                          eq(
                              asyncJobs.subjectId,
                              recordingJobSubject(itemId, view),
                          ),
                          inArray(asyncJobs.status, ["pending", "processing"]),
                      ),
                  )
                  .limit(1)
            : Promise.resolve([]),
        item.kind === "audio"
            ? db
                  .select({
                      errorCode: asyncJobs.errorCode,
                      completedAt: asyncJobs.completedAt,
                  })
                  .from(asyncJobs)
                  .where(
                      and(
                          eq(asyncJobs.userId, userId),
                          eq(asyncJobs.kind, TRANSCRIPTION_JOB_KIND),
                          eq(
                              asyncJobs.subjectId,
                              recordingJobSubject(itemId, view),
                          ),
                          eq(asyncJobs.status, "failed"),
                          sql`${asyncJobs.payload} ->> 'trigger' <> 'manual'`,
                      ),
                  )
                  .orderBy(
                      desc(asyncJobs.completedAt),
                      desc(asyncJobs.createdAt),
                  )
                  .limit(1)
            : Promise.resolve([]),
        item.kind === "audio"
            ? db
                  .select({ audioReapedAt: recordings.audioReapedAt })
                  .from(recordings)
                  .where(
                      and(
                          eq(recordings.id, itemId),
                          eq(recordings.userId, userId),
                      ),
                  )
                  .limit(1)
            : Promise.resolve([]),
        db
            .select({ id: learnRuns.id })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, itemId),
                    eq(learnRuns.userId, userId),
                    eq(learnRuns.view, "private"),
                    learnRunOpen(),
                ),
            )
            .limit(1),
    ]);
    const placementFolderIds = placements.map((row) => row.folderId);
    const intendedFolderIds = intents.map((row) => row.folderId);
    const phases =
        processing?.phases ??
        legacyPhases({
            kind: item.kind,
            hasPlacement:
                placementFolderIds.length > 0 || intendedFolderIds.length > 0,
            content: content
                ? { id: content.id, revision: content.revision }
                : null,
        });
    const categorizedAsLegacy =
        phases.categorize?.state === "done" &&
        phases.categorize.reason === "legacy";
    const profileAssigned = Boolean(
        processing?.profileId && processing.profileRevisionId,
    );
    const folderIds = [...placementFolderIds, ...intendedFolderIds];
    const resolution =
        view === "private" && folderIds.length > 0 && !profileAssigned
            ? await resolveProfileForPlacements({
                  ownerUserId: userId,
                  itemId,
                  channel: item.kind,
                  folderIds,
                  view,
              })
            : null;
    const resolvedProfile =
        view === "private" &&
        (profileAssigned || categorizedAsLegacy || processing?.profileId)
            ? await resolveItemProfile(itemId, "private", userId)
            : null;
    const profile = resolvedProfile
        ? {
              revisionId: resolvedProfile.revisionId,
              transcribe:
                  "transcribe" in resolvedProfile.settings.steps
                      ? {
                            enabled:
                                resolvedProfile.settings.steps.transcribe
                                    .enabled,
                            automatic:
                                resolvedProfile.settings.steps.transcribe
                                    .automatic,
                            plaudTranscript:
                                resolvedProfile.settings.steps.transcribe
                                    .plaudTranscript,
                        }
                      : undefined,
              automatic: {
                  learn:
                      resolvedProfile.settings.steps.learn.enabled &&
                      resolvedProfile.settings.steps.learn.automatic,
                  summary:
                      resolvedProfile.settings.steps.summary.enabled &&
                      resolvedProfile.settings.steps.summary.automatic,
                  title:
                      resolvedProfile.settings.steps.title.enabled &&
                      resolvedProfile.settings.steps.title.automatic,
                  topics:
                      "topics" in resolvedProfile.settings.steps &&
                      resolvedProfile.settings.steps.topics.enabled &&
                      resolvedProfile.settings.steps.topics.automatic,
              },
              learn: {
                  enabled: resolvedProfile.settings.steps.learn.enabled,
                  automatic: resolvedProfile.settings.steps.learn.automatic,
              },
          }
        : null;
    let learnAvailability: PipelineFacts["learnAvailability"] = "no_provider";
    if (!isLearnDeploymentAvailable()) {
        learnAvailability = "hosted";
    } else if (
        resolvedProfile?.settings.steps.learn.enabled &&
        resolvedProfile.settings.steps.learn.automatic
    ) {
        try {
            await resolveStepProvider({
                step: "learn",
                pin: resolvedProfile.settings.steps.learn.provider,
                actorUserId: userId,
            });
            learnAvailability = "available";
        } catch {
            learnAvailability = "no_provider";
        }
    }
    const shareProblems =
        intendedFolderIds.length === 0
            ? []
            : item.kind === "mail"
              ? await db.transaction((tx) =>
                    mailShareProblems(tx, itemId, userId),
                )
              : await loadShareGate(db, itemId, userId);
    const summaryExists = summary !== undefined;
    const learn = phases.learn;
    const releasedCurrentContent =
        item.kind === "audio" &&
        item.summaryDueAt === null &&
        content !== null &&
        learn?.state === "done" &&
        learn.reason === "released" &&
        learn.inputs?.contentId === content.id &&
        learn.inputs.contentSourceId === "riffado" &&
        learn.inputs.contentRevision === content.revision;

    return {
        item: {
            exists: true,
            deleted: item.deletedAt !== null,
            kind: item.kind,
            ownerUserId: userId,
        },
        view,
        generation: processing?.requestedGeneration ?? 0,
        content: content
            ? {
                  contentId: content.id,
                  contentSourceId: item.kind === "audio" ? "riffado" : "mail",
                  contentRevision: content.revision,
                  timed: content.timed,
              }
            : null,
        transcription:
            item.kind === "audio"
                ? {
                      riffado: content
                          ? {
                                contentId: content.id,
                                contentSourceId: "riffado",
                                contentRevision: content.revision,
                                timed: content.timed,
                            }
                          : null,
                      plaud: plaudTranscript
                          ? {
                                contentId: plaudTranscript.id,
                                contentSourceId: "plaud",
                                contentRevision: plaudTranscript.revision,
                                timed: plaudTranscript.timed,
                            }
                          : null,
                      jobActive: transcriptionJob !== undefined,
                      contentReaped: item.contentReapedAt !== null,
                      audioReaped: recording?.audioReapedAt != null,
                      shared,
                      ...(failedTranscriptionJob?.completedAt
                          ? {
                                failed: {
                                    errorCode:
                                        failedTranscriptionJob.errorCode ??
                                        "TRANSCRIPTION_FAILED",
                                    completedAt:
                                        failedTranscriptionJob.completedAt.toISOString(),
                                },
                            }
                          : {}),
                  }
                : undefined,
        summaryDueAt: item.summaryDueAt?.toISOString() ?? null,
        profile,
        categorization: {
            placementFolderIds,
            intendedFolderIds,
            profileAssigned,
            resolution: resolution?.status ?? null,
        },
        hasEnhancementCredential: Boolean(
            pickEnhancementCredential(credentials),
        ),
        learnAvailability,
        learnRunOpen: openLearnRun !== undefined,
        mail: item.kind === "mail" && mail ? { ...mail, shared } : null,
        summary: {
            exists: summaryExists,
            stale:
                summaryExists && releasedCurrentContent
                    ? await isSummaryStale(userId, itemId)
                    : false,
            jobActive: summaryJob !== undefined,
        },
        taskReview: {
            proposals: proposals.length,
            followUps: followUps.length,
        },
        share: { problems: shareProblems },
        phases,
        at: new Date().toISOString(),
    };
}
