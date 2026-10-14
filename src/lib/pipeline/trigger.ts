import { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import { incrementProcessingRequestInTx } from "@/db/queries/pipeline";
import { nudge } from "@/lib/jobs/nudge";
import type { PipelineView } from "@/lib/pipeline/types";
import { recordingJobSubject } from "@/lib/sharing/view";

/** Queue kind for the durable pipeline driver. */
export const PIPELINE_ADVANCE_JOB_KIND = "pipeline.advance";

export type PipelineAdvanceReason = "transcript" | "arrival" | "learn-released";

export interface RequestAdvanceInput {
    itemId: string;
    userId: string;
    view: PipelineView;
    reason: PipelineAdvanceReason;
}

export interface RequestAdvanceResult {
    requestedGeneration: number;
    enqueued: boolean;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Increment a pipeline request and enqueue its driver in the caller's transaction. */
export async function requestAdvanceInTx(
    tx: Tx,
    input: RequestAdvanceInput,
): Promise<RequestAdvanceResult | null> {
    const requestedGeneration = await incrementProcessingRequestInTx(
        tx,
        input.itemId,
        input.view,
        input.userId,
    );
    if (requestedGeneration === null) return null;

    const enqueued = await enqueueJobInTx(tx, {
        userId: input.userId,
        kind: PIPELINE_ADVANCE_JOB_KIND,
        subjectId: recordingJobSubject(input.itemId, input.view),
        maxAttempts: 10,
        payload: {
            itemId: input.itemId,
            view: input.view,
            reason: input.reason,
        },
    });
    return { requestedGeneration, enqueued };
}

/** Request a pipeline advance atomically, then wake the local worker. */
export async function requestAdvance(
    input: RequestAdvanceInput,
): Promise<RequestAdvanceResult | null> {
    const result = await db.transaction((tx) => requestAdvanceInTx(tx, input));
    if (result?.enqueued) nudge();
    return result;
}
