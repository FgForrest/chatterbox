import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import { notifyFolderReceiversInTx } from "@/db/queries/item-shares";
import {
    incrementProcessingRequestInTx,
    wakePendingPipelineAdvanceInTx,
} from "@/db/queries/pipeline";
import { recordings } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { attachArrivingRecordingInTx } from "@/lib/meetings/attachment";
import { pipelineDriver } from "@/lib/pipeline/driver";
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
    if (input.reason === "arrival") {
        const [recording] = await tx
            .select({ fileId: recordings.plaudFileId })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, input.itemId),
                    eq(recordings.userId, input.userId),
                ),
            )
            .limit(1);
        if (recording)
            await attachArrivingRecordingInTx(
                tx,
                input.userId,
                input.itemId,
                recording.fileId,
            );
    }
    const result = await requestAdvanceForViewInTx(tx, {
        ...input,
        ...pipelineDriver(input.userId),
    });
    if (
        result &&
        (input.reason === "arrival" ||
            input.reason === "placement" ||
            input.reason === "categorized")
    )
        await notifyFolderReceiversInTx(tx, input.userId, input.itemId);
    return result;
}

/** Advance an exact stored row when maintaining a legacy pipeline view. */
export async function requestAdvanceForViewInTx(
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
