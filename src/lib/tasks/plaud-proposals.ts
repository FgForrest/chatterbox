import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    itemProcessing,
    recordings,
    recordingTaskRejections,
    recordingTasks,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
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
import {
    newTaskProposals,
    type TaskProposals,
    writeTaskProposalsInTx,
} from "@/lib/tasks/store";
import { readTaskItems } from "@/lib/tasks/summary-items";

/** Stable, non-reversible identity of one imported Plaud action-item list. */
export function plaudActionItemsFingerprint(
    actionItems: readonly string[],
): string {
    return domainLookupHash("plaud-action-items", JSON.stringify(actionItems));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function matchesPlaudProposalsInTx(
    tx: Tx,
    itemId: string,
    userId: string,
    proposals: TaskProposals,
): Promise<boolean> {
    const rows = await tx
        .select({
            text: recordingTasks.text,
            source: recordingTasks.source,
            status: recordingTasks.status,
            version: recordingTasks.version,
            assigneeHint: recordingTasks.assigneeHint,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            quote: recordingTasks.quote,
            evidenceStartMs: recordingTasks.evidenceStartMs,
            evidenceSegmentIndex: recordingTasks.evidenceSegmentIndex,
            evidenceCharStart: recordingTasks.evidenceCharStart,
            evidenceCharEnd: recordingTasks.evidenceCharEnd,
            evidenceProvenance: recordingTasks.evidenceProvenance,
        })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, itemId),
                eq(recordingTasks.userId, userId),
            ),
        )
        .orderBy(
            recordingTasks.position,
            recordingTasks.createdAt,
            recordingTasks.id,
        );
    const untouched: typeof rows = [];
    const known = new Set<string>();
    for (const row of rows) {
        if (
            row.source === "plaud" &&
            row.status === "proposed" &&
            row.version === 0
        ) {
            untouched.push(row);
        } else {
            known.add(proposals.fingerprintOf(decryptText(row.text)));
        }
    }

    const rejections = await tx
        .select({ fingerprint: recordingTaskRejections.fingerprintHmac })
        .from(recordingTaskRejections)
        .where(
            and(
                eq(recordingTaskRejections.itemId, itemId),
                eq(recordingTaskRejections.userId, userId),
                inArray(
                    recordingTaskRejections.fingerprintHmac,
                    proposals.tasks.map((task) => task.fingerprint),
                ),
            ),
        );
    const expected = newTaskProposals(
        proposals.tasks,
        known,
        new Set(rejections.map((row) => row.fingerprint)),
    );
    return (
        untouched.length === expected.length &&
        expected.every((task, index) => {
            const row = untouched[index];
            return (
                decryptText(row.text) === task.text &&
                decryptText(row.assigneeHint) === task.assigneeHint &&
                row.dueDate === task.dueDate &&
                decryptText(row.duePhrase) === task.duePhrase &&
                decryptText(row.quote) === task.quote &&
                row.evidenceStartMs === task.evidenceStartMs &&
                row.evidenceSegmentIndex ===
                    (task.evidenceText?.segmentIndex ?? null) &&
                row.evidenceCharStart ===
                    (task.evidenceText?.charStart ?? null) &&
                row.evidenceCharEnd === (task.evidenceText?.charEnd ?? null) &&
                row.evidenceProvenance === (task.evidenceProvenance ?? null)
            );
        })
    );
}

/** Apply imported action items or recognize matching legacy proposals. */
export async function applyPlaudActionItemProposals(input: {
    itemId: string;
    userId: string;
    view: PipelineView;
    expectedFingerprint: string;
    record: PhaseRecord;
    settle?: boolean;
    keepMatchingProposals?: true;
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
        const alreadyApplied =
            input.keepMatchingProposals === true &&
            refreshGeneration <= input.record.generation &&
            (await matchesPlaudProposalsInTx(
                tx,
                input.itemId,
                input.userId,
                proposals,
            ));
        if (!alreadyApplied)
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
