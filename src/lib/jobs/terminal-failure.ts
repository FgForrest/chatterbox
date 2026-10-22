import type { AsyncJobRow } from "@/db/queries/async-jobs";
import { getJobHandler } from "./registry";

/** Run retained cleanup and notification hooks after a terminal transaction commits. */
export async function afterTerminalJobFailure(job: AsyncJobRow): Promise<void> {
    const handler = getJobHandler(job.kind);
    if (!handler?.onTerminalFailure) return;
    try {
        await handler.onTerminalFailure({
            jobId: job.id,
            userId: job.userId,
            payload: handler.parsePayload(job.payload),
            errorCode: job.errorCode ?? "INTERNAL_ERROR",
            errorMessage: job.lastError ?? undefined,
        });
    } catch (error) {
        console.error("[job-worker] terminal failure hook failed", {
            jobId: job.id,
            error,
        });
    }
}
