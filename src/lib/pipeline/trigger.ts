import { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import {
    incrementProcessingRequestInTx,
    wakePendingPipelineAdvanceInTx,
} from "@/db/queries/pipeline";
import { nudge } from "@/lib/jobs/nudge";
import type { PipelineView } from "@/lib/pipeline/types";
import { recordingJobSubject } from "@/lib/sharing/view";

/** Queue kind for the durable pipeline driver. */
export const PIPELINE_ADVANCE_JOB_KIND = "pipeline.advance";

export type PipelineAdvanceReason =
    | "provider-changed"
    | "transcript"
    | "arrival"
    | "learn-released"
    | "categorized"
    | "placement"
    | "summary"
    | "title"
    | "learn-settled"
    | "review-finished"
    | "correction-finished"
    | "task-review"
    | "share-gate"
    | "transcription-failed"
    | "summary-step-failed"
    | "transcription-retry"
    | "process-again";

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

    const subjectId = recordingJobSubject(input.itemId, input.view);
    const enqueued = await enqueueJobInTx(tx, {
        userId: input.userId,
        kind: PIPELINE_ADVANCE_JOB_KIND,
        subjectId,
        maxAttempts: 10,
        payload: {
            itemId: input.itemId,
            view: input.view,
            reason: input.reason,
        },
    });
    if (!enqueued) {
        await wakePendingPipelineAdvanceInTx(tx, input.userId, subjectId);
    }
    return { requestedGeneration, enqueued };
}

/** Request a pipeline advance atomically, then wake the local worker. */
export async function requestAdvance(
    input: RequestAdvanceInput,
): Promise<RequestAdvanceResult | null> {
    const result = await db.transaction((tx) => requestAdvanceInTx(tx, input));
    if (result) nudge();
    return result;
}
