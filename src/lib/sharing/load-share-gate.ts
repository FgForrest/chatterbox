import {
    and,
    asc,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    not,
} from "drizzle-orm";
import type { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";
import { effectiveManualOnly } from "@/lib/pipeline/effective-profile";
import { isProviderBlockedReason, stepRequested } from "@/lib/pipeline/plan";
import type {
    ContentRevisionInput,
    PhaseRecord,
    PipelinePhases,
} from "@/lib/pipeline/types";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import type { ProfileSettings, ProviderPin } from "@/lib/profiles/settings";
import {
    evaluateShareGate,
    type ShareGateProblem,
} from "@/lib/sharing/share-gate";
import { recordingJobSubject } from "@/lib/sharing/view";
import { automaticSummaryReplacementAllowed } from "@/lib/summary/replacement";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { waitingTaskDecisions } from "@/lib/tasks/waiting-review";
import { preferredTranscript } from "@/lib/transcription/preferred-source";
import { readPreferredTranscriptInput } from "@/lib/transcription/read-source";

type Executor = Pick<typeof db, "select">;

/** Whether this filing introduces automatic work before the first publication. */
export async function placementNeedsAutomaticReview(
    executor: Executor,
    itemId: string,
    ownerUserId: string,
    settings: ProfileSettings,
    processing: { profileRevisionId: string | null; phases: PipelinePhases },
): Promise<boolean> {
    const learn =
        settings.steps.learn.automatic && isLearnDeploymentAvailable();
    const summary = settings.steps.summary;
    if (!learn && !summary.automatic) return false;
    const content = await readPreferredTranscriptInput(
        itemId,
        ownerUserId,
        executor,
    );
    if (
        learn &&
        (await unfinishedLearn(
            executor,
            itemId,
            ownerUserId,
            content
                ? { id: content.contentId, revision: content.contentRevision }
                : undefined,
            processing.phases.learn,
        ))
    )
        return true;
    if (!summary.automatic) return false;
    const phase = processing.phases.summary;
    // A current aggregate wait already belongs to an earlier Summary workflow.
    if (
        content &&
        phase?.state === "waiting" &&
        !phase.steps &&
        phase.inputs?.contentId === content.contentId &&
        phase.inputs.contentRevision === content.contentRevision
    )
        return false;
    return unfinishedSummary(
        executor,
        itemId,
        ownerUserId,
        content,
        processing,
        summary.provider,
    );
}

/**
 * First-publication requirements for an audio item, read in the owner's private scope.
 */
export async function loadShareGate(
    executor: Executor,
    recordingId: string,
    ownerUserId: string,
): Promise<ShareGateProblem[]> {
    const [item] = await executor
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, ownerUserId),
                eq(chatterItems.kind, "audio"),
                isNull(chatterItems.deletedAt),
                not(recordingSharedCondition(chatterItems.id)),
            ),
        )
        .limit(1);
    if (!item) return [];

    const [transcripts, [processing], decisions] = await Promise.all([
        executor
            .select({
                id: transcriptions.id,
                source: transcriptions.source,
                model: transcriptions.model,
                revision: transcriptions.revision,
                text: transcriptions.text,
                turns: transcriptions.turns,
            })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, ownerUserId),
                ),
            )
            .orderBy(asc(transcriptions.source)),
        executor
            .select({
                profileId: itemProcessing.profileId,
                profileRevisionId: itemProcessing.profileRevisionId,
                manualOnly: itemProcessing.manualOnly,
                phases: itemProcessing.phases,
            })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, recordingId),
                    eq(itemProcessing.userId, ownerUserId),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .limit(1),
        waitingTaskDecisions(executor, recordingId, ownerUserId, "private"),
    ]);
    const phases = processing?.phases;
    const profile =
        !effectiveManualOnly(processing) &&
        (processing?.profileId ||
            phases?.categorize?.placementProfile ||
            phases?.categorize?.reason === "legacy")
            ? await resolveItemProfile(
                  recordingId,
                  "private",
                  ownerUserId,
                  ownerUserId,
                  undefined,
                  undefined,
                  executor,
              ).catch((error: unknown) => {
                  if (
                      error instanceof AppError &&
                      error.code === ErrorCode.CONFLICT
                  )
                      return null;
                  throw error;
              })
            : null;
    const preferred = preferredTranscript(transcripts);
    const [learnUnfinished, summaryUnfinished, attributions] =
        await Promise.all([
            profile?.settings.steps.learn.automatic &&
            isLearnDeploymentAvailable()
                ? unfinishedLearn(
                      executor,
                      recordingId,
                      ownerUserId,
                      preferred,
                      phases?.learn,
                  )
                : false,
            profile?.settings.steps.summary.automatic
                ? unfinishedSummary(
                      executor,
                      recordingId,
                      ownerUserId,
                      preferred
                          ? {
                                contentId: preferred.id,
                                contentSourceId: preferred.source,
                                contentRevision: preferred.revision,
                            }
                          : null,
                      processing,
                      profile.settings.steps.summary.provider,
                  )
                : false,
            transcripts.length > 0
                ? executor
                      .select({
                          transcriptionId: transcriptSpeakers.transcriptionId,
                          label: transcriptSpeakers.label,
                          status: transcriptSpeakers.status,
                          personId: transcriptSpeakers.personId,
                          markedUnknown: transcriptSpeakers.markedUnknown,
                      })
                      .from(transcriptSpeakers)
                      .where(
                          inArray(
                              transcriptSpeakers.transcriptionId,
                              transcripts.map((transcript) => transcript.id),
                          ),
                      )
                : [],
        ]);
    return evaluateShareGate({
        transcripts: transcripts.map((transcript) => ({
            id: transcript.id,
            source: transcript.source,
            labels: transcriptSpeakerLabels(transcript),
        })),
        attributions,
        learnUnfinished,
        tasksUnreviewed: decisions.total > 0,
        summaryUnfinished,
    });
}

async function unfinishedLearn(
    executor: Executor,
    itemId: string,
    ownerUserId: string,
    preferred: { id: string; revision: number } | undefined,
    phase: PhaseRecord | undefined,
): Promise<boolean> {
    if (!preferred) return true;
    const [run] = await executor
        .select({ status: learnRuns.status })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, itemId),
                eq(learnRuns.userId, ownerUserId),
                eq(learnRuns.view, "private"),
                eq(learnRuns.transcriptionId, preferred.id),
                eq(learnRuns.transcriptRevision, preferred.revision),
            ),
        )
        .orderBy(desc(learnRuns.createdAt), desc(learnRuns.id))
        .limit(1);
    if (run?.status === "finished") return false;
    if (run && ["queued", "running", "ready", "failed"].includes(run.status))
        return true;
    const currentPhase =
        !phase?.inputs ||
        (phase.inputs.contentId === preferred.id &&
            phase.inputs.contentRevision === preferred.revision);
    return !(
        currentPhase &&
        (phase?.state === "skipped" || phase?.state === "done")
    );
}

async function unfinishedSummary(
    executor: Executor,
    itemId: string,
    ownerUserId: string,
    content: ContentRevisionInput | null,
    processing:
        | { profileRevisionId: string | null; phases: PipelinePhases }
        | undefined,
    provider: ProviderPin | null,
): Promise<boolean> {
    const [active] = await executor
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, ownerUserId),
                eq(asyncJobs.subjectId, recordingJobSubject(itemId, "private")),
                eq(asyncJobs.kind, SUMMARY_JOB_KIND),
                inArray(asyncJobs.status, ["pending", "processing"]),
            ),
        )
        .limit(1);
    if (active) return true;
    const phase = processing?.phases.summary;
    const step = phase?.steps?.summary;
    const state =
        step?.state ??
        (phase?.reason === "legacy" || !phase?.steps
            ? phase?.state
            : undefined);
    if (state === "pending" || state === "running" || state === "waiting")
        return true;
    if ((state === "skipped" || state === "failed") && phase && content) {
        const categorize = processing?.phases.categorize;
        const learn = processing?.phases.learn;
        const released =
            learn?.state === "done" &&
            learn.reason === "released" &&
            learn.inputs?.contentId === content.contentId &&
            learn.inputs.contentSourceId === content.contentSourceId &&
            learn.inputs.contentRevision === content.contentRevision;
        const minimumGeneration =
            categorize?.summaryRefresh?.generation ??
            (categorize?.reason === "process_again"
                ? categorize.generation
                : 0);
        const terminal =
            step ??
            (phase.inputs && {
                ...phase.inputs,
                state,
                reason: phase.reason,
                generation: phase.generation,
            });
        if (
            terminal &&
            stepRequested(
                { ...phase, steps: { summary: terminal } },
                "summary",
                content,
                Math.max(minimumGeneration, released ? learn.generation : 0),
                false,
                released,
            )
        ) {
            if (!isProviderBlockedReason(terminal.reason)) return false;
            const providerAvailable = await resolveStepProviderSelection({
                step: "summary",
                pin: provider,
                actorUserId: ownerUserId,
                readOnly: true,
            }).then(
                () => true,
                () => false,
            );
            if (!providerAvailable) return false;
        }
    }

    const inputs = step ?? phase?.inputs;
    if (
        state === "done" &&
        !processing?.phases.categorize?.summaryRefresh &&
        (!inputs ||
            (inputs.contentId === content?.contentId &&
                inputs.contentRevision === content.contentRevision))
    )
        return false;

    const [saved] = await executor
        .select({
            id: aiEnhancements.id,
            revision: aiEnhancements.revision,
            source: aiEnhancements.source,
            editedAt: aiEnhancements.editedAt,
            inputs: aiEnhancements.inputs,
            transcriptionId: aiEnhancements.transcriptionId,
        })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, itemId),
                eq(aiEnhancements.userId, ownerUserId),
                isNotNull(aiEnhancements.summary),
            ),
        )
        .orderBy(desc(aiEnhancements.source))
        .limit(1);
    return automaticSummaryReplacementAllowed(saved, content, processing);
}
