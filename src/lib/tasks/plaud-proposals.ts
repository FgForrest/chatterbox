import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, recordings } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import type { PhaseRecord, PipelineView } from "@/lib/pipeline/types";
import { contentWriterScope, sharingOrgUserId } from "@/lib/sharing/writer";
import { readPlaudTaskSource } from "@/lib/summary/read-summary";
import { taskViewerById } from "@/lib/tasks/access";
import { resolveTaskProposals } from "@/lib/tasks/proposals";
import { writeTaskProposalsInTx } from "@/lib/tasks/store";
import { readTaskItems } from "@/lib/tasks/summary-items";

/** Stable, non-reversible identity of one imported Plaud action-item list. */
export function plaudActionItemsFingerprint(
    actionItems: readonly string[],
): string {
    return domainLookupHash("plaud-action-items", JSON.stringify(actionItems));
}

/** Replace untouched Plaud proposals and record the Summary-step outcome. */
export async function applyPlaudActionItemProposals(input: {
    itemId: string;
    userId: string;
    view: PipelineView;
    expectedFingerprint: string;
    record: PhaseRecord;
}): Promise<boolean> {
    const source = await readPlaudTaskSource(input.userId, input.itemId);
    if (
        !source ||
        source.actionItems.length === 0 ||
        plaudActionItemsFingerprint(source.actionItems) !==
            input.expectedFingerprint
    ) {
        return false;
    }
    const items = readTaskItems(source.actionItems).map((item) => ({
        ...item,
        candidates: null,
    }));
    const proposals = await resolveTaskProposals({
        source: "plaud",
        items,
        updates: [],
        refs: new Map(),
        ownerUserId: input.userId,
        transcriptionId: source.transcriptionId,
        turns: null,
        language: null,
        orgView: input.view === "org",
        reviewer: await taskViewerById(input.userId),
        summaryText: source.summary,
    });
    proposals.matches = [];
    proposals.updates = [];
    const orgUserId = await sharingOrgUserId();

    return db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, input.itemId),
                    eq(recordings.userId, input.userId),
                ),
            )
            .for("update");
        const { scopeUserId } = await contentWriterScope(tx, {
            recordingId: input.itemId,
            ownerUserId: input.userId,
            actorUserId: input.userId,
            orgUserId,
        });
        const [current] = await tx
            .select({ actionItems: aiEnhancements.actionItems })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, input.itemId),
                    eq(aiEnhancements.userId, input.userId),
                    eq(aiEnhancements.source, "plaud"),
                ),
            )
            .for("update")
            .limit(1);
        const currentItems = current
            ? (decryptJsonField<string[]>(current.actionItems) ?? [])
            : [];
        if (
            plaudActionItemsFingerprint(currentItems) !==
            input.expectedFingerprint
        ) {
            return false;
        }
        await writeTaskProposalsInTx(tx, {
            recordingId: input.itemId,
            ownerUserId: input.userId,
            actorUserId: input.userId,
            view:
                orgUserId !== null && scopeUserId === orgUserId
                    ? "org"
                    : input.view,
            contentSourceId: "plaud",
            proposals,
        });
        await updatePhaseInTx(
            tx,
            input.itemId,
            input.view,
            input.userId,
            "summary",
            input.record,
        );
        await requestAdvanceInTx(tx, {
            itemId: input.itemId,
            userId: input.userId,
            view: input.view,
            reason: "summary",
        });
        return true;
    });
}
