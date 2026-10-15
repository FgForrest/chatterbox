import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { db } from "@/db";
import { liveFollowUpCondition } from "@/db/queries/tasks";
import {
    aiEnhancements,
    chatterItems,
    type EvidenceProvenance,
    people,
    recordingTaskRejections,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { linkedTaskMentionCondition } from "@/lib/tasks/mentions";

export { liveFollowUpCondition } from "@/db/queries/tasks";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProposedTask {
    text: string;
    /** `fingerprintOf(text)`. */
    fingerprint: string;
    assigneePersonId: string | null;
    assigneeHint: string | null;
    assigneeCheck: boolean;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    /** Where in a mail the quote is: a range of one segment's text. */
    evidenceText?: TextEvidence | null;
    /**
     * The quote is in a quoted part of a mail, by a sender nothing
     * verified, or not found in a mail with quoted parts: the proposal then
     * starts unticked.
     */
    evidenceProvenance?: EvidenceProvenance | null;
}

/** A range of one segment of a mail's content. */
export interface TextEvidence {
    segmentIndex: number;
    charStart: number;
    charEnd: number;
}

export interface ProposedTaskUpdate {
    taskId: string;
    kind: "done" | "due";
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText?: TextEvidence | null;
    evidenceProvenance?: EvidenceProvenance | null;
}

/** What one summary proposes, ready to store. */
export interface TaskProposals {
    source: "riffado" | "plaud";
    tasks: ProposedTask[];
    updates: ProposedTaskUpdate[];
    /**
     * The keyed fingerprint of a task text (`taskFingerprint`), passed in so
     * this module needs no secret of its own: the write compares the
     * recording's tasks under its lock.
     */
    fingerprintOf: (text: string) => string;
}

/**
 * Store a summary's proposals for its recording, in the summary's
 * transaction: they replace the proposals the same source made before that
 * nobody touched (edited, ticked, merged or added ones stay), skip what was
 * rejected on this recording or is already one of its rows, and replace
 * the untouched task updates this recording proposed.
 */
export async function writeTaskProposalsInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        actorUserId,
        view = "private",
        contentSourceId = null,
        contentRevision = null,
        proposals,
    }: {
        recordingId: string;
        ownerUserId: string;
        actorUserId: string;
        view?: "private" | "org";
        contentSourceId?: string | null;
        contentRevision?: number | null;
        proposals: TaskProposals;
    },
): Promise<void> {
    const [item] = await tx
        .select({ occurredAt: chatterItems.occurredAt })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, ownerUserId),
            ),
        )
        .limit(1);
    if (!item) return;
    await tx
        .delete(taskMentions)
        .where(
            and(
                eq(taskMentions.itemId, recordingId),
                eq(taskMentions.userId, ownerUserId),
                eq(taskMentions.view, view),
                eq(taskMentions.matchDecision, "suggested"),
            ),
        );
    await tx
        .delete(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                eq(recordingTasks.userId, ownerUserId),
                eq(recordingTasks.status, "proposed"),
                eq(recordingTasks.source, proposals.source),
                eq(recordingTasks.version, 0),
            ),
        );
    // Untouched follow-ups are heard again; stale ones (the task moved on)
    // have nothing left to review.
    await tx
        .delete(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, recordingId),
                eq(taskUpdateProposals.userId, ownerUserId),
                sql`(${taskUpdateProposals.version} = 0 or not ${liveFollowUpCondition()})`,
            ),
        );

    const rejected = new Set(
        (
            await tx
                .select({
                    fingerprint: recordingTaskRejections.fingerprintHmac,
                })
                .from(recordingTaskRejections)
                .where(
                    and(
                        eq(recordingTaskRejections.itemId, recordingId),
                        eq(recordingTaskRejections.userId, ownerUserId),
                    ),
                )
        ).map((row) => row.fingerprint),
    );
    const kept = await tx
        .select({
            text: recordingTasks.text,
            position: recordingTasks.position,
        })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                eq(recordingTasks.userId, ownerUserId),
            ),
        );
    let position = kept.reduce((max, row) => Math.max(max, row.position), -1);
    const known = new Set(
        kept.map((row) => proposals.fingerprintOf(decryptText(row.text))),
    );

    // What the summary named may have gone while it ran (minutes, with
    // several passes): a person deleted, a task closed or deleted.
    const assignees = [
        ...new Set(
            proposals.tasks.flatMap((task) =>
                task.assigneePersonId ? [task.assigneePersonId] : [],
            ),
        ),
    ];
    const livePeople = new Set(
        assignees.length > 0
            ? (
                  await tx
                      .select({ id: people.id })
                      .from(people)
                      .where(
                          and(
                              inArray(people.id, assignees),
                              isNull(people.mergedIntoId),
                          ),
                      )
              ).map((row) => row.id)
            : [],
    );
    const targets = [...new Set(proposals.updates.map((u) => u.taskId))];
    const openTasks = new Set(
        targets.length > 0
            ? (
                  await tx
                      .select({ id: recordingTasks.id })
                      .from(recordingTasks)
                      .where(
                          and(
                              inArray(recordingTasks.id, targets),
                              eq(recordingTasks.status, "open"),
                          ),
                      )
              ).map((row) => row.id)
            : [],
    );

    const rows: (typeof recordingTasks.$inferInsert)[] = [];
    for (const task of proposals.tasks) {
        const { fingerprint } = task;
        if (rejected.has(fingerprint) || known.has(fingerprint)) continue;
        known.add(fingerprint);
        position += 1;
        rows.push({
            itemId: recordingId,
            userId: ownerUserId,
            status: "proposed" as const,
            text: encryptText(task.text),
            assigneePersonId:
                task.assigneePersonId && livePeople.has(task.assigneePersonId)
                    ? task.assigneePersonId
                    : null,
            assigneeHint: encryptText(task.assigneeHint),
            assigneeCheck: task.assigneeCheck,
            dueDate: task.dueDate,
            duePhrase: encryptText(task.duePhrase),
            quote: encryptText(task.quote),
            evidenceStartMs: task.evidenceStartMs,
            evidenceSegmentIndex: task.evidenceText?.segmentIndex ?? null,
            evidenceCharStart: task.evidenceText?.charStart ?? null,
            evidenceCharEnd: task.evidenceText?.charEnd ?? null,
            evidenceProvenance: task.evidenceProvenance ?? null,
            source: proposals.source,
            ticked: !task.assigneeCheck && !task.evidenceProvenance,
            position,
            createdByUserId: actorUserId,
            originItemId: recordingId,
        });
    }
    const insertedTasks =
        rows.length > 0
            ? await tx
                  .insert(recordingTasks)
                  .values(rows)
                  .returning({ id: recordingTasks.id })
            : [];
    if (insertedTasks.length > 0) {
        await tx.insert(taskMentions).values(
            insertedTasks.map((row, index) => {
                const stored = rows[index];
                return {
                    taskId: row.id,
                    itemId: recordingId,
                    userId: ownerUserId,
                    view,
                    evidenceStartMs: stored?.evidenceStartMs ?? null,
                    evidenceSegmentIndex: stored?.evidenceSegmentIndex ?? null,
                    evidenceCharStart: stored?.evidenceCharStart ?? null,
                    evidenceCharEnd: stored?.evidenceCharEnd ?? null,
                    quote: stored?.quote ?? null,
                    provenance: stored?.evidenceProvenance ?? null,
                    contentSourceId,
                    contentRevision,
                    statementAt: item.occurredAt,
                    matchDecision: "home" as const,
                };
            }),
        );
    }

    const updates = proposals.updates.filter((update) =>
        openTasks.has(update.taskId),
    );
    if (updates.length > 0) {
        const insertedUpdates = await tx
            .insert(taskUpdateProposals)
            .values(
                updates.map((update) => ({
                    taskId: update.taskId,
                    itemId: recordingId,
                    userId: ownerUserId,
                    kind: update.kind,
                    dueDate: update.dueDate,
                    duePhrase: encryptText(update.duePhrase),
                    quote: encryptText(update.quote),
                    evidenceStartMs: update.evidenceStartMs,
                    evidenceSegmentIndex:
                        update.evidenceText?.segmentIndex ?? null,
                    evidenceCharStart: update.evidenceText?.charStart ?? null,
                    evidenceCharEnd: update.evidenceText?.charEnd ?? null,
                    evidenceProvenance: update.evidenceProvenance ?? null,
                })),
            )
            .onConflictDoNothing()
            .returning({
                id: taskUpdateProposals.id,
                taskId: taskUpdateProposals.taskId,
                kind: taskUpdateProposals.kind,
            });
        if (insertedUpdates.length > 0) {
            await tx.insert(taskMentions).values(
                insertedUpdates.map((row) => {
                    const update = updates.find(
                        (candidate) =>
                            candidate.taskId === row.taskId &&
                            candidate.kind === row.kind,
                    );
                    if (!update)
                        throw new Error("inserted follow-up was not found");
                    return {
                        id: row.id,
                        taskId: row.taskId,
                        itemId: recordingId,
                        userId: ownerUserId,
                        view,
                        evidenceStartMs: update.evidenceStartMs,
                        evidenceSegmentIndex:
                            update.evidenceText?.segmentIndex ?? null,
                        evidenceCharStart:
                            update.evidenceText?.charStart ?? null,
                        evidenceCharEnd: update.evidenceText?.charEnd ?? null,
                        quote: encryptText(update.quote),
                        provenance: update.evidenceProvenance ?? null,
                        contentSourceId,
                        contentRevision,
                        statementAt: item.occurredAt,
                        matchDecision: "suggested" as const,
                    };
                }),
            );
        }
    }
}

/**
 * A recording's tasks, its remembered rejections, and the follow-ups heard
 * on it, gone: the recording itself is going.
 */
export async function deleteRecordingTasksInTx(
    tx: Tx,
    recordingId: string,
): Promise<void> {
    await tx
        .delete(taskUpdateProposals)
        .where(eq(taskUpdateProposals.itemId, recordingId));
    await tx
        .delete(recordingTasks)
        .where(eq(recordingTasks.itemId, recordingId));
    await tx
        .delete(recordingTaskRejections)
        .where(eq(recordingTaskRejections.itemId, recordingId));
}

/**
 * Tasks die with the summary (Johnny, 2026-10-07): once a recording has no
 * summary left (retention, Erase, deleting it), its tasks go too. Call it
 * after deleting a summary, in the same transaction.
 */
export async function dropTasksWithoutSummaryInTx(
    tx: Tx,
    { recordingId, ownerUserId }: { recordingId: string; ownerUserId: string },
): Promise<void> {
    const [left] = await tx
        .select({ id: aiEnhancements.id })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recordingId),
                eq(aiEnhancements.userId, ownerUserId),
            ),
        )
        .limit(1);
    if (!left) {
        const affected = new Set(
            (
                await tx
                    .select({ id: taskMentions.taskId })
                    .from(taskMentions)
                    .where(
                        and(
                            eq(taskMentions.itemId, recordingId),
                            eq(taskMentions.userId, ownerUserId),
                        ),
                    )
            ).map((row) => row.id),
        );
        const homeTasks = await tx
            .select({ id: recordingTasks.id, userId: recordingTasks.userId })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, recordingId),
                    eq(recordingTasks.userId, ownerUserId),
                ),
            );
        for (const row of homeTasks) affected.add(row.id);
        const affectedTasks =
            affected.size > 0
                ? await tx
                      .select({
                          id: recordingTasks.id,
                          userId: recordingTasks.userId,
                      })
                      .from(recordingTasks)
                      .where(inArray(recordingTasks.id, [...affected]))
                : [];
        await tx
            .delete(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.itemId, recordingId),
                    eq(taskUpdateProposals.userId, ownerUserId),
                ),
            );
        await tx
            .delete(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, recordingId),
                    eq(taskMentions.userId, ownerUserId),
                ),
            );
        for (const task of affectedTasks) {
            await tx.delete(recordingTasks).where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, task.userId),
                    notExists(
                        tx
                            .select({ id: taskMentions.id })
                            .from(taskMentions)
                            .where(
                                and(
                                    eq(taskMentions.taskId, recordingTasks.id),
                                    linkedTaskMentionCondition(),
                                ),
                            ),
                    ),
                ),
            );
        }
        await tx
            .delete(recordingTaskRejections)
            .where(
                and(
                    eq(recordingTaskRejections.itemId, recordingId),
                    eq(recordingTaskRejections.userId, ownerUserId),
                ),
            );
    }
}
