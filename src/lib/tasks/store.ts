import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { db } from "@/db";
import { ANY_TASK_ITEM, taskVisible } from "@/db/queries/task-visibility";
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
import type { TaskViewer } from "@/lib/tasks/access";
import {
    fieldProposalIsLater,
    plausibleQuotedStatementTime,
} from "@/lib/tasks/chronology";
import { shouldPreselectTaskOutcome } from "@/lib/tasks/summary-items";

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
    /** A quoted mail header's claimed time, bounded when it is stored. */
    quotedAt?: Date | null;
    /** Existing tasks this ambiguous commitment may be, if any. */
    candidateTaskIds?: string[];
}

/** A range of one segment of a mail's content. */
export interface TextEvidence {
    segmentIndex: number;
    charStart: number;
    charEnd: number;
}

export interface ProposedTaskUpdate {
    taskId: string;
    kind: "done" | "due" | "due_phrase";
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText?: TextEvidence | null;
    evidenceProvenance?: EvidenceProvenance | null;
    quotedAt?: Date | null;
    /** Field changes never start selected. */
    ticked?: false;
}

export interface ProposedTaskMatch {
    taskId: string;
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText?: TextEvidence | null;
    evidenceProvenance?: EvidenceProvenance | null;
    quotedAt?: Date | null;
    /** Derived from the one-candidate, trustworthy-evidence rule. */
    ticked: boolean;
}

/** What one summary proposes, ready to store. */
export interface TaskProposals {
    source: "riffado" | "plaud";
    tasks: ProposedTask[];
    matches?: ProposedTaskMatch[];
    updates: ProposedTaskUpdate[];
    /** Reviewer whose candidate visibility is rechecked when output commits. */
    reviewer?: TaskViewer;
    /**
     * The keyed fingerprint of a task text (`taskFingerprint`), passed in so
     * this module needs no secret of its own: the write compares the
     * recording's tasks under its lock.
     */
    fingerprintOf: (text: string) => string;
}

type ProposedEvidence = Pick<
    ProposedTaskMatch,
    | "quote"
    | "evidenceStartMs"
    | "evidenceText"
    | "evidenceProvenance"
    | "quotedAt"
>;

type ProposedMatchEvidence = ProposedEvidence & { ticked: boolean };

function statementAt(itemOccurredAt: Date, evidence: ProposedEvidence): Date {
    return evidence.evidenceProvenance === "quoted"
        ? plausibleQuotedStatementTime(itemOccurredAt, evidence.quotedAt)
        : itemOccurredAt;
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
    const ambiguousMatches = proposals.tasks.flatMap((task) => {
        const candidateTaskIds = [...new Set(task.candidateTaskIds ?? [])];
        return candidateTaskIds.map(
            (taskId): ProposedTaskMatch => ({
                taskId,
                quote: task.quote,
                evidenceStartMs: task.evidenceStartMs,
                evidenceText: task.evidenceText,
                evidenceProvenance: task.evidenceProvenance,
                quotedAt: task.quotedAt,
                ticked: shouldPreselectTaskOutcome(
                    "match",
                    candidateTaskIds.length,
                    task.evidenceProvenance,
                ),
            }),
        );
    });
    const proposedMatches = [
        ...(proposals.matches ?? []).map((match) => ({
            ...match,
            ticked: shouldPreselectTaskOutcome(
                "match",
                1,
                match.evidenceProvenance,
            ),
        })),
        ...ambiguousMatches,
    ];
    const targets = [
        ...new Set([
            ...proposedMatches.map((match) => match.taskId),
            ...proposals.updates.map((update) => update.taskId),
        ]),
    ];
    const openTasks = new Map(
        targets.length > 0
            ? (
                  await tx
                      .select({
                          id: recordingTasks.id,
                          statusEffectiveAt: recordingTasks.statusEffectiveAt,
                          dueEffectiveAt: recordingTasks.dueEffectiveAt,
                      })
                      .from(recordingTasks)
                      .innerJoin(
                          chatterItems,
                          eq(chatterItems.id, recordingTasks.itemId),
                      )
                      .where(
                          and(
                              inArray(recordingTasks.id, targets),
                              eq(recordingTasks.status, "open"),
                              isNull(chatterItems.deletedAt),
                              proposals.reviewer
                                  ? taskVisible(
                                        proposals.reviewer,
                                        ANY_TASK_ITEM,
                                    )
                                  : undefined,
                          ),
                      )
              ).map((row) => [row.id, row] as const)
            : [],
    );
    for (const taskId of targets) {
        if (!openTasks.has(taskId)) {
            console.warn(
                `[tasks] ignored task candidate ${taskId}: it is no longer available`,
            );
        }
    }
    const existingMentions = new Set(
        targets.length > 0
            ? (
                  await tx
                      .select({ taskId: taskMentions.taskId })
                      .from(taskMentions)
                      .where(
                          and(
                              inArray(taskMentions.taskId, targets),
                              eq(taskMentions.itemId, recordingId),
                              eq(taskMentions.userId, ownerUserId),
                              eq(taskMentions.view, view),
                          ),
                      )
              ).map((row) => row.taskId)
            : [],
    );

    const rows: (typeof recordingTasks.$inferInsert)[] = [];
    const rowStatements: Date[] = [];
    for (const task of proposals.tasks) {
        const { fingerprint } = task;
        if (rejected.has(fingerprint) || known.has(fingerprint)) continue;
        known.add(fingerprint);
        position += 1;
        rowStatements.push(statementAt(item.occurredAt, task));
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
            ticked:
                !task.assigneeCheck &&
                !task.evidenceProvenance &&
                (task.candidateTaskIds?.length ?? 0) === 0,
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
                    statementAt: rowStatements[index] ?? item.occurredAt,
                    matchDecision: "home" as const,
                };
            }),
        );
    }

    const mentionByTask = new Map<string, ProposedMatchEvidence>();
    for (const match of proposedMatches) {
        if (
            !openTasks.has(match.taskId) ||
            existingMentions.has(match.taskId) ||
            mentionByTask.has(match.taskId)
        ) {
            continue;
        }
        mentionByTask.set(match.taskId, {
            ...match,
            ticked: match.ticked,
        });
    }
    for (const update of proposals.updates) {
        if (
            !openTasks.has(update.taskId) ||
            existingMentions.has(update.taskId) ||
            mentionByTask.has(update.taskId)
        ) {
            continue;
        }
        mentionByTask.set(update.taskId, { ...update, ticked: false });
    }
    if (mentionByTask.size > 0) {
        await tx.insert(taskMentions).values(
            [...mentionByTask].map(([taskId, evidence]) => ({
                taskId,
                itemId: recordingId,
                userId: ownerUserId,
                view,
                evidenceStartMs: evidence.evidenceStartMs,
                evidenceSegmentIndex:
                    evidence.evidenceText?.segmentIndex ?? null,
                evidenceCharStart: evidence.evidenceText?.charStart ?? null,
                evidenceCharEnd: evidence.evidenceText?.charEnd ?? null,
                quote: encryptText(evidence.quote),
                provenance: evidence.evidenceProvenance ?? null,
                contentSourceId,
                contentRevision,
                statementAt: statementAt(item.occurredAt, evidence),
                matchDecision: "suggested" as const,
                ticked: evidence.ticked,
            })),
        );
    }

    const updates = proposals.updates.filter((update) => {
        const target = openTasks.get(update.taskId);
        if (!target || existingMentions.has(update.taskId)) return false;
        const effectiveAt =
            update.kind === "done"
                ? target.statusEffectiveAt
                : target.dueEffectiveAt;
        return fieldProposalIsLater(
            statementAt(item.occurredAt, update),
            effectiveAt,
        );
    });
    if (updates.length > 0) {
        await tx
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
                    ticked: false,
                })),
            )
            .onConflictDoNothing();
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
                                    inArray(taskMentions.matchDecision, [
                                        "home",
                                        "accepted",
                                    ]),
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
