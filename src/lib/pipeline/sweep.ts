import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import {
    listAutomaticTranscriptionRetryRows,
    listStalledPipelineRows,
    updateProcessingPhaseInTx,
} from "@/db/queries/pipeline";
import { reconcilePipelineSteps } from "@/db/queries/pipeline-reconciler";
import { itemProcessing } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { afterTerminalJobFailure } from "@/lib/jobs/terminal-failure";
import { isProviderBlockedReason } from "@/lib/pipeline/plan";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvanceForViewInTx,
} from "@/lib/pipeline/trigger";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { recordingJobSubject } from "@/lib/sharing/view";

const SWEEP_MS = 60_000;
/** Maximum automatic transcription retries requested by one sweep. */
export const AUTO_TRANSCRIBE_RETRY_LIMIT = 5;
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
            const marked = await updateProcessingPhaseInTx(
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
                await requestAdvanceForViewInTx(tx, {
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

/** Start the minute-level lost-wake-up sweep once per process. */
export function startPipelineSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => {
        void Promise.all([
            sweepStalledPipelines(),
            reconcilePipelineSteps(
                undefined,
                undefined,
                undefined,
                afterTerminalJobFailure,
            ),
            sweepAutomaticTranscriptionRetries(),
        ]).catch((error) => console.error("[pipeline] sweep failed:", error));
    }, SWEEP_MS);
    sweeper.unref?.();
}
