import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import {
    listAutomaticTranscriptionRetryRows,
    listStalledPipelineRows,
} from "@/db/queries/pipeline";
import { nudge } from "@/lib/jobs/nudge";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import {
    PIPELINE_ADVANCE_JOB_KIND,
    requestAdvanceInTx,
} from "@/lib/pipeline/trigger";
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
): Promise<number> {
    const rows = await listAutomaticTranscriptionRetryRows(limit);
    let requested = 0;
    for (const row of rows) {
        const didRequest = await db.transaction(async (tx) => {
            const generation = row.requestedGeneration + 1;
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

/** Start the minute-level lost-wake-up sweep once per process. */
export function startPipelineSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => {
        void Promise.all([
            sweepStalledPipelines(),
            sweepAutomaticTranscriptionRetries(),
        ]).catch((error) => console.error("[pipeline] sweep failed:", error));
    }, SWEEP_MS);
    sweeper.unref?.();
}
