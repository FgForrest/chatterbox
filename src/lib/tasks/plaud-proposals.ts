import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, itemProcessing, recordings } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import { JobDeferredError } from "@/lib/jobs/deferred";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import type { PhaseRecord, PipelineView } from "@/lib/pipeline/types";
import { trimHolds } from "@/lib/recordings/trim-proposal";
import { contentWriterScope, sharingOrgUserId } from "@/lib/sharing/writer";
import { readPlaudTaskSource } from "@/lib/summary/read-summary";
import { mayAutomaticallyReplaceSummary } from "@/lib/summary/replacement";
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
    settle?: boolean;
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
            .for("update")
            .limit(1);
        if (trimHolds(processing?.phases.trim))
            throw new JobDeferredError(30_000, "Waiting for trim decision");
        const previous = processing?.phases.summary?.steps?.summary;
        const categorize = processing?.phases.categorize;
        const refreshGeneration = Math.max(
            categorize?.summaryRefresh?.generation ?? -1,
            categorize?.reason === "process_again" ? categorize.generation : -1,
        );
        if (
            previous?.state === "done" &&
            previous?.sourceFingerprint === input.expectedFingerprint &&
            previous.contentId === input.record.inputs?.contentId &&
            previous.contentSourceId === input.record.inputs?.contentSourceId &&
            previous.contentRevision === input.record.inputs?.contentRevision &&
            refreshGeneration <= previous.generation
        )
            return false;
        const [custom] = await tx
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, input.itemId),
                    eq(aiEnhancements.userId, input.userId),
                    eq(aiEnhancements.source, "riffado"),
                    isNotNull(aiEnhancements.summary),
                ),
            )
            .limit(1);
        if (
            custom &&
            !(await mayAutomaticallyReplaceSummary(
                input.userId,
                input.itemId,
                tx,
            ))
        )
            return false;
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
        if (input.settle !== false)
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
