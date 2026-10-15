import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import {
    readProcessingRow,
    updateProcessingPhaseInTx,
} from "@/db/queries/pipeline";
import {
    chatterItems,
    itemProcessing,
    mailContents,
    transcriptions,
} from "@/db/schema";
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
 * Persist that Learn released the current content, or timed out awaiting review.
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
        timedOut?: boolean;
    },
): Promise<boolean> {
    const [processing] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .limit(1);
    let content = processing?.phases.learn?.inputs;
    if (!content) {
        const [item] = await tx
            .select({ kind: chatterItems.kind })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, input.itemId),
                    eq(chatterItems.userId, input.userId),
                ),
            )
            .limit(1);
        if (item?.kind === "audio") {
            const [transcript] = await tx
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
            if (transcript) {
                content = {
                    contentId: transcript.id,
                    contentSourceId: "riffado",
                    contentRevision: transcript.revision,
                };
            }
        } else if (item?.kind === "mail") {
            const [mail] = await tx
                .select({
                    id: mailContents.id,
                    revision: mailContents.revision,
                })
                .from(mailContents)
                .where(
                    and(
                        eq(mailContents.itemId, input.itemId),
                        eq(mailContents.userId, input.userId),
                    ),
                )
                .limit(1);
            if (mail) {
                content = {
                    contentId: mail.id,
                    contentSourceId: "mail",
                    contentRevision: mail.revision,
                };
            }
        }
    }
    if (!content) return false;
    return updatePhaseInTx(tx, input.itemId, "private", input.userId, "learn", {
        state: input.timedOut ? "waiting" : "done",
        reason: input.timedOut ? "review_pending_timeout" : "released",
        generation: input.generation,
        inputs: content,
        at: new Date().toISOString(),
    });
}
