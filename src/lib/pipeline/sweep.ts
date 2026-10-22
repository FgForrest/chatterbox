import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import {
    listAutomaticTranscriptionRetryRows,
    listOrphanedPipelineStepRows,
    listStalledPipelineRows,
} from "@/db/queries/pipeline";
import { asyncJobs, itemProcessing } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { isProviderBlockedReason } from "@/lib/pipeline/plan";
import {
    markSummaryStepFailedInTx,
    updatePhaseInTx,
} from "@/lib/pipeline/state";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvanceInTx,
} from "@/lib/pipeline/trigger";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { TITLE_JOB_KIND } from "@/lib/recordings/title-job";
import { recordingJobSubject } from "@/lib/sharing/view";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { TOPICS_JOB_KIND } from "@/lib/topics/topics-job";
import { TRANSCRIPTION_JOB_KIND } from "@/lib/transcription/transcription-job";

const SWEEP_MS = 60_000;
/** Maximum automatic transcription retries requested by one sweep. */
export const AUTO_TRANSCRIBE_RETRY_LIMIT = 5;
export const ORPHANED_STEP_SWEEP_LIMIT = 100;
let sweeper: ReturnType<typeof setInterval> | undefined;

/** Re-enqueue pipeline work whose active driver wake-up was lost. */
export async function sweepStalledPipelines(limit = 500): Promise<number> {
    const rows = await listStalledPipelineRows(limit);
    let enqueued = 0;
    for (const row of rows) {
        const result = await enqueueJob({
            userId: row.userId,
            kind: PIPELINE_ADVANCE_JOB_KIND,
            subjectId: recordingJobSubject(row.itemId, row.view),
            maxAttempts: 10,
            payload: { itemId: row.itemId, view: row.view, reason: "stalled" },
        });
        if (result.created) enqueued++;
    }
    if (enqueued > 0) nudge();
    return enqueued;
}

/** Request bounded retries for automatic transcription failures older than 30 minutes. */
export async function sweepAutomaticTranscriptionRetries(
    limit = AUTO_TRANSCRIBE_RETRY_LIMIT,
    scope?: { userId: string; itemId: string },
): Promise<number> {
    const rows = await listAutomaticTranscriptionRetryRows(limit, scope);
    let requested = 0;
    for (const row of rows) {
        if (isProviderBlockedReason(row.reason)) {
            try {
                const profile = await resolveItemProfile(
                    row.itemId,
                    "private",
                    row.userId,
                );
                if (
                    !("transcribe" in profile.settings.steps) ||
                    !profile.settings.steps.transcribe.automatic
                )
                    continue;
                await resolveStepProviderSelection({
                    step: "transcription",
                    pin: profile.settings.steps.transcribe.provider,
                    actorUserId: row.userId,
                });
            } catch {
                continue;
            }
        }
        const didRequest = await db.transaction(async (tx) => {
            const [current] = await tx
                .select({
                    phases: itemProcessing.phases,
                    generation: itemProcessing.requestedGeneration,
                })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, row.itemId),
                        eq(itemProcessing.userId, row.userId),
                        eq(itemProcessing.view, row.view),
                    ),
                )
                .for("update")
                .limit(1);
            if (
                current?.phases.transcribe?.state !== "failed" ||
                current.generation !== row.requestedGeneration
            )
                return false;
            const generation = current.generation + 1;
            const marked = await updatePhaseInTx(
                tx,
                row.itemId,
                row.view,
                row.userId,
                "transcribe",
                {
                    state: "pending",
                    reason: "automatic_retry",
                    automatic: true,
                    generation,
                    at: new Date().toISOString(),
                },
            );
            if (!marked) return false;
            return Boolean(
                await requestAdvanceInTx(tx, {
                    itemId: row.itemId,
                    userId: row.userId,
                    view: row.view,
                    reason: "transcription-retry",
                }),
            );
        });
        if (didRequest) requested++;
    }
    if (requested > 0) nudge();
    return requested;
}

/** Settle pipeline steps whose final job ended without recording its outcome. */
export async function sweepOrphanedPipelineSteps(
    limit = ORPHANED_STEP_SWEEP_LIMIT,
): Promise<number> {
    const rows = await listOrphanedPipelineStepRows(limit);
    let settled = 0;
    for (const row of rows) {
        const didSettle = await db.transaction(async (tx) => {
            const [processing] = await tx
                .select({ phases: itemProcessing.phases })
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, row.itemId),
                        eq(itemProcessing.userId, row.userId),
                        eq(itemProcessing.view, row.view),
                    ),
                )
                .for("update")
                .limit(1);
            if (
                !processing ||
                processing.phases[row.phase]?.generation !== row.phaseGeneration
            )
                return false;
            const jobKind =
                row.phase === "transcribe"
                    ? TRANSCRIPTION_JOB_KIND
                    : row.step === "summary"
                      ? SUMMARY_JOB_KIND
                      : row.step === "title"
                        ? TITLE_JOB_KIND
                        : TOPICS_JOB_KIND;
            const [active] = await tx
                .select({ id: asyncJobs.id })
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, row.userId),
                        eq(asyncJobs.kind, jobKind),
                        eq(
                            asyncJobs.subjectId,
                            recordingJobSubject(row.itemId, row.view),
                        ),
                        inArray(asyncJobs.status, ["pending", "processing"]),
                    ),
                )
                .limit(1);
            if (active) return false;

            if (row.phase === "summary" && row.step) {
                return markSummaryStepFailedInTx(tx, {
                    itemId: row.itemId,
                    userId: row.userId,
                    view: row.view,
                    step: row.step,
                    errorCode: row.errorCode,
                });
            }
            const transcribe = processing.phases.transcribe;
            if (
                transcribe?.state !== "running" ||
                transcribe.automatic !== true
            ) {
                return false;
            }
            const advance = await requestAdvanceInTx(tx, {
                itemId: row.itemId,
                userId: row.userId,
                view: row.view,
                reason: "transcription-failed",
            });
            if (!advance) return false;
            return updatePhaseInTx(
                tx,
                row.itemId,
                row.view,
                row.userId,
                "transcribe",
                {
                    ...transcribe,
                    state: "failed",
                    reason: row.errorCode,
                    generation: advance.requestedGeneration,
                    at: new Date().toISOString(),
                },
            );
        });
        if (didSettle) settled++;
    }
    if (settled > 0) nudge();
    return settled;
}

/** Start the minute-level lost-wake-up sweep once per process. */
export function startPipelineSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => {
        void Promise.all([
            sweepStalledPipelines(),
            sweepOrphanedPipelineSteps(),
            sweepAutomaticTranscriptionRetries(),
        ]).catch((error) => console.error("[pipeline] sweep failed:", error));
    }, SWEEP_MS);
    sweeper.unref?.();
}
