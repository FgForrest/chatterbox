import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import {
    readProcessingRow,
    updateProcessingPhaseInTx,
} from "@/db/queries/pipeline";
import { transcriptions } from "@/db/schema";
import type {
    PhaseName,
    PhaseRecord,
    PipelineView,
} from "@/lib/pipeline/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Read an item's processing state for one owner and view. */
export function readProcessing(
    itemId: string,
    view: PipelineView,
    userId: string,
) {
    return readProcessingRow(itemId, view, userId);
}

/** Write one phase without replacing a record from a higher generation. */
export function updatePhaseInTx(
    tx: Tx,
    itemId: string,
    view: PipelineView,
    userId: string,
    phase: PhaseName,
    record: PhaseRecord,
): Promise<boolean> {
    return updateProcessingPhaseInTx(tx, itemId, view, userId, phase, record);
}

/**
 * Persist the durable fact that Learn released one transcript row and revision.
 *
 * `generation` must be the requested generation returned by
 * `requestAdvanceInTx` in the same transaction (Task 1.4), so the release is
 * never older than the run that serves it.
 */
export async function markLearnReleasedInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        generation: number;
    },
): Promise<boolean> {
    const [content] = await tx
        .select({
            id: transcriptions.id,
            revision: transcriptions.revision,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, input.itemId),
                eq(transcriptions.userId, input.userId),
                eq(transcriptions.source, "riffado"),
            ),
        )
        .limit(1);
    if (!content) return false;
    return updatePhaseInTx(tx, input.itemId, "private", input.userId, "learn", {
        state: "done",
        reason: "released",
        generation: input.generation,
        inputs: {
            contentId: content.id,
            contentSourceId: "riffado",
            contentRevision: content.revision,
        },
        at: new Date().toISOString(),
    });
}
