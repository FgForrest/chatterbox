import type { db } from "@/db";
import {
    readProcessingRow,
    updateProcessingPhaseInTx,
} from "@/db/queries/pipeline";
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
 * Persist the durable fact that Learn released one transcript revision.
 *
 * `generation` must be the requested generation returned by
 * `requestAdvanceInTx` in the same transaction (Task 1.4), so the release is
 * never older than the run that serves it.
 */
export function markLearnReleasedInTx(
    tx: Tx,
    input: {
        itemId: string;
        userId: string;
        contentRevision: number;
        generation: number;
    },
): Promise<boolean> {
    return updatePhaseInTx(tx, input.itemId, "private", input.userId, "learn", {
        state: "done",
        reason: "released",
        generation: input.generation,
        inputs: {
            contentSourceId: "riffado",
            contentRevision: input.contentRevision,
        },
        at: new Date().toISOString(),
    });
}
