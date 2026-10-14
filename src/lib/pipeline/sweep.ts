import { enqueueJob } from "@/db/queries/async-jobs";
import { listStalledPipelineRows } from "@/db/queries/pipeline";
import { nudge } from "@/lib/jobs/nudge";
import { PIPELINE_ADVANCE_JOB_KIND } from "@/lib/pipeline/trigger";
import { recordingJobSubject } from "@/lib/sharing/view";

const SWEEP_MS = 60_000;
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

/** Start the minute-level lost-wake-up sweep once per process. */
export function startPipelineSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => {
        void sweepStalledPipelines().catch((error) =>
            console.error("[pipeline] sweep failed:", error),
        );
    }, SWEEP_MS);
    sweeper.unref?.();
}
