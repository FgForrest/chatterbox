import {
    type AnyColumn,
    and,
    asc,
    desc,
    eq,
    inArray,
    isNull,
    or,
    type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTaskRejections,
    recordingTasks,
    taskHomeMoves,
    taskMentions,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { sharedItemCondition } from "@/lib/sharing/shared";
import type { TaskViewer } from "@/lib/tasks/access";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface MentionColumns {
    itemId: AnyColumn;
    userId: AnyColumn;
    view: AnyColumn;
}

interface MentionDecisionColumn {
    matchDecision: AnyColumn;
}

interface ItemColumns {
    id: AnyColumn;
    userId: AnyColumn;
    deletedAt: AnyColumn;
}

const DEFAULT_MENTION_COLUMNS: MentionColumns = {
    itemId: taskMentions.itemId,
    userId: taskMentions.userId,
    view: taskMentions.view,
};

const DEFAULT_ITEM_COLUMNS: ItemColumns = {
    id: chatterItems.id,
    userId: chatterItems.userId,
    deletedAt: chatterItems.deletedAt,
};

const DEFAULT_MENTION_DECISION_COLUMN: MentionDecisionColumn = {
    matchDecision: taskMentions.matchDecision,
};

/** SQL: a mention is linked to its task and may serve as evidence. */
export function linkedTaskMentionCondition(
    mention: MentionDecisionColumn = DEFAULT_MENTION_DECISION_COLUMN,
): SQL {
    return inArray(mention.matchDecision, ["home", "accepted"]);
}

/** SQL: a mention's source item is currently visible to `viewer`. */
export function taskMentionVisible(
    viewer: TaskViewer,
    mention: MentionColumns = DEFAULT_MENTION_COLUMNS,
    item: ItemColumns = DEFAULT_ITEM_COLUMNS,
): SQL {
    const own = and(
        eq(item.userId, viewer.userId),
        eq(mention.userId, viewer.userId),
    );
    const organization = viewer.orgUserId
        ? and(
              eq(mention.view, "org"),
              sharedItemCondition(viewer.orgUserId, item.id),
          )
        : undefined;
    return and(
        eq(item.id, mention.itemId),
        eq(item.userId, mention.userId),
        isNull(item.deletedAt),
        viewer.isOrg ? organization : or(own, organization),
    ) as SQL;
}

/** SQL: a mention belongs in the requested archive scope. */
export function archivedTaskMentionVisible(
    scope: ArchiveScope | { kind: "owner"; userId: string },
    mention: MentionColumns = DEFAULT_MENTION_COLUMNS,
    item: ItemColumns = DEFAULT_ITEM_COLUMNS,
): SQL {
    const visible =
        scope.kind === "organization"
            ? and(
                  eq(mention.view, "org"),
                  sharedItemCondition(scope.orgUserId, item.id),
              )
            : and(
                  eq(item.userId, scope.userId),
                  eq(mention.userId, scope.userId),
              );
    return and(
        eq(item.id, mention.itemId),
        eq(item.userId, mention.userId),
        isNull(item.deletedAt),
        visible,
    ) as SQL;
}

export interface TaskMentionEvidence {
    id: string;
    taskId: string;
    itemId: string;
    kind: "audio" | "mail";
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceSegmentIndex: number | null;
    evidenceCharStart: number | null;
    evidenceCharEnd: number | null;
    provenance: "quoted" | "unverified" | "unlocated" | null;
    statementAt: Date;
}

export interface LoadedTaskMentions {
    latest: Map<string, TaskMentionEvidence>;
    quotes: Map<string, { text: string; kind: "audio" | "mail" }[]>;
    taskIdsWithMentions: Set<string>;
}

async function loadTaskMentions(
    taskIds: readonly string[],
    visible: SQL,
): Promise<LoadedTaskMentions> {
    const latest = new Map<string, TaskMentionEvidence>();
    const quotes = new Map<
        string,
        { text: string; kind: "audio" | "mail" }[]
    >();
    const taskIdsWithMentions = new Set<string>();
    if (taskIds.length === 0) return { latest, quotes, taskIdsWithMentions };

    const [all, rows] = await Promise.all([
        db
            .select({ taskId: taskMentions.taskId })
            .from(taskMentions)
            .where(
                and(
                    inArray(taskMentions.taskId, [...taskIds]),
                    linkedTaskMentionCondition(),
                ),
            ),
        db
            .select({
                id: taskMentions.id,
                taskId: taskMentions.taskId,
                itemId: taskMentions.itemId,
                kind: chatterItems.kind,
                quote: taskMentions.quote,
                evidenceStartMs: taskMentions.evidenceStartMs,
                evidenceSegmentIndex: taskMentions.evidenceSegmentIndex,
                evidenceCharStart: taskMentions.evidenceCharStart,
                evidenceCharEnd: taskMentions.evidenceCharEnd,
                provenance: taskMentions.provenance,
                statementAt: taskMentions.statementAt,
            })
            .from(taskMentions)
            .innerJoin(chatterItems, eq(chatterItems.id, taskMentions.itemId))
            .innerJoin(
                recordingTasks,
                eq(recordingTasks.id, taskMentions.taskId),
            )
            .where(
                and(
                    inArray(taskMentions.taskId, [...taskIds]),
                    linkedTaskMentionCondition(),
                    visible,
                ),
            )
            .orderBy(
                desc(eq(taskMentions.itemId, recordingTasks.itemId)),
                desc(taskMentions.statementAt),
                desc(taskMentions.createdAt),
                asc(taskMentions.id),
            ),
    ]);
    for (const row of all) taskIdsWithMentions.add(row.taskId);
    for (const row of rows) {
        const evidence = {
            ...row,
            quote: row.quote ? decryptText(row.quote) : null,
        };
        if (!latest.has(row.taskId)) latest.set(row.taskId, evidence);
        if (evidence.quote) {
            const values = quotes.get(row.taskId) ?? [];
            values.push({ text: evidence.quote, kind: evidence.kind });
            quotes.set(row.taskId, values);
        }
    }
    return { latest, quotes, taskIdsWithMentions };
}

/** The newest visible evidence and all visible quotes for each task. */
export function loadVisibleTaskMentions(
    viewer: TaskViewer,
    taskIds: readonly string[],
): Promise<LoadedTaskMentions> {
    return loadTaskMentions(taskIds, taskMentionVisible(viewer));
}

/** The newest archive-visible evidence and all visible quotes for each task. */
export function loadArchivedTaskMentions(
    scope: ArchiveScope | { kind: "owner"; userId: string },
    taskIds: readonly string[],
): Promise<LoadedTaskMentions> {
    return loadTaskMentions(taskIds, archivedTaskMentionVisible(scope));
}

interface MoveInput {
    itemId: string;
    ownerUserId: string;
    actorUserId: string;
    orgUserId: string | null;
    reason: "deleted" | "erased" | "withdrawn";
    removeMentions: boolean;
}

interface RemainingMention {
    taskId: string;
    itemId: string;
    userId: string;
    view: "private" | "org";
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceSegmentIndex: number | null;
    evidenceCharStart: number | null;
    evidenceCharEnd: number | null;
    provenance: "quoted" | "unverified" | "unlocated" | null;
    statementAt: Date;
}

interface LockedTaskRow {
    id: string;
    itemId: string;
    userId: string;
}

interface ItemRef {
    id: string;
    kind: "audio" | "mail";
}

async function taskIdsOnItem(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
): Promise<string[]> {
    const [homes, mentions, updates] = await Promise.all([
        tx
            .select({ id: recordingTasks.id })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, itemId),
                    eq(recordingTasks.userId, ownerUserId),
                ),
            ),
        tx
            .select({ id: taskMentions.taskId })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, itemId),
                    eq(taskMentions.userId, ownerUserId),
                ),
            ),
        tx
            .select({ id: taskUpdateProposals.taskId })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.itemId, itemId),
                    eq(taskUpdateProposals.userId, ownerUserId),
                ),
            ),
    ]);
    return [
        ...new Set([...homes, ...mentions, ...updates].map((row) => row.id)),
    ];
}

async function taskGraphItemRefs(
    tx: Tx,
    sourceItemId: string,
    taskIds: readonly string[],
): Promise<ItemRef[]> {
    const ids = new Set([sourceItemId]);
    if (taskIds.length > 0) {
        const [tasks, mentions] = await Promise.all([
            tx
                .select({ itemId: recordingTasks.itemId })
                .from(recordingTasks)
                .where(inArray(recordingTasks.id, [...taskIds])),
            tx
                .select({ itemId: taskMentions.itemId })
                .from(taskMentions)
                .where(inArray(taskMentions.taskId, [...taskIds])),
        ]);
        for (const row of [...tasks, ...mentions]) ids.add(row.itemId);
    }
    return tx
        .select({ id: chatterItems.id, kind: chatterItems.kind })
        .from(chatterItems)
        .where(inArray(chatterItems.id, [...ids]))
        .orderBy(asc(chatterItems.id));
}

async function lockItemRefs(tx: Tx, refs: readonly ItemRef[]): Promise<void> {
    for (const ref of [...refs].sort((a, b) => a.id.localeCompare(b.id))) {
        if (ref.kind === "audio") {
            await tx
                .select({ id: recordings.id })
                .from(recordings)
                .where(eq(recordings.id, ref.id))
                .for("update");
        } else {
            await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, ref.id),
                        eq(chatterItems.kind, "mail"),
                    ),
                )
                .for("update");
        }
    }
}

async function readLockedTasks(
    tx: Tx,
    taskIds: readonly string[],
): Promise<LockedTaskRow[]> {
    if (taskIds.length === 0) return [];
    return tx
        .select({
            id: recordingTasks.id,
            itemId: recordingTasks.itemId,
            userId: recordingTasks.userId,
        })
        .from(recordingTasks)
        .where(inArray(recordingTasks.id, [...taskIds]))
        .orderBy(asc(recordingTasks.id))
        .for("update");
}

/** Lock one item's task graph in item-id order, then task-id order. */
export async function lockItemTaskGraphInTx(
    tx: Tx,
    input: { itemId: string; ownerUserId: string },
): Promise<LockedTaskRow[]> {
    let taskIds = await taskIdsOnItem(tx, input.itemId, input.ownerUserId);
    let refs = await taskGraphItemRefs(tx, input.itemId, taskIds);
    await lockItemRefs(tx, refs);

    taskIds = await taskIdsOnItem(tx, input.itemId, input.ownerUserId);
    const rereadRefs = await taskGraphItemRefs(tx, input.itemId, taskIds);
    const lockedItemIds = new Set(refs.map((ref) => ref.id));
    const missingBeforeTasks = rereadRefs.filter(
        (ref) => !lockedItemIds.has(ref.id),
    );
    await lockItemRefs(tx, missingBeforeTasks);
    refs = [...refs, ...missingBeforeTasks];

    let tasks = await readLockedTasks(tx, taskIds);
    const mentions =
        taskIds.length === 0
            ? []
            : await tx
                  .select({ itemId: taskMentions.itemId })
                  .from(taskMentions)
                  .where(inArray(taskMentions.taskId, taskIds));
    const lockedAfterTasks = new Set(refs.map((ref) => ref.id));
    const missedIds = [
        ...new Set(
            mentions
                .map((mention) => mention.itemId)
                .filter((itemId) => !lockedAfterTasks.has(itemId)),
        ),
    ];
    if (missedIds.length > 0) {
        const missedRefs = await tx
            .select({ id: chatterItems.id, kind: chatterItems.kind })
            .from(chatterItems)
            .where(inArray(chatterItems.id, missedIds))
            .orderBy(asc(chatterItems.id));
        await lockItemRefs(tx, missedRefs);
        taskIds = await taskIdsOnItem(tx, input.itemId, input.ownerUserId);
        tasks = await readLockedTasks(tx, taskIds);
        if (taskIds.length > 0) {
            await tx
                .select({ itemId: taskMentions.itemId })
                .from(taskMentions)
                .where(inArray(taskMentions.taskId, taskIds));
        }
    }
    return tasks;
}

async function moveItemTaskHomesInTx(tx: Tx, input: MoveInput): Promise<void> {
    const locked = await lockItemTaskGraphInTx(tx, input);
    const now = new Date();
    if (input.reason === "withdrawn") {
        await tx
            .update(taskUpdateProposals)
            .set({
                state: "obsolete",
                routedTo: null,
                decidedByUserId: null,
                decidedAt: now,
                obsoleteReason: "source_withdrawn",
                updatedAt: now,
            })
            .where(
                and(
                    eq(taskUpdateProposals.itemId, input.itemId),
                    eq(taskUpdateProposals.userId, input.ownerUserId),
                    inArray(taskUpdateProposals.state, [
                        "awaiting_share",
                        "awaiting_target_review",
                    ]),
                ),
            );
    }
    const mentioned = new Set(
        (
            await tx
                .select({ id: taskMentions.taskId })
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.itemId, input.itemId),
                        eq(taskMentions.userId, input.ownerUserId),
                    ),
                )
        ).map((row) => row.id),
    );
    const affected = locked.filter(
        (task) =>
            (task.itemId === input.itemId &&
                task.userId === input.ownerUserId) ||
            (input.removeMentions && mentioned.has(task.id)),
    );
    if (affected.length === 0) return;

    const taskIds = affected.map((task) => task.id);
    if (input.removeMentions) {
        await tx
            .delete(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, input.itemId),
                    eq(taskMentions.userId, input.ownerUserId),
                    inArray(taskMentions.taskId, taskIds),
                ),
            );
    }

    const remaining = await tx
        .select({
            taskId: taskMentions.taskId,
            itemId: taskMentions.itemId,
            userId: taskMentions.userId,
            view: taskMentions.view,
            quote: taskMentions.quote,
            evidenceStartMs: taskMentions.evidenceStartMs,
            evidenceSegmentIndex: taskMentions.evidenceSegmentIndex,
            evidenceCharStart: taskMentions.evidenceCharStart,
            evidenceCharEnd: taskMentions.evidenceCharEnd,
            provenance: taskMentions.provenance,
            statementAt: taskMentions.statementAt,
        })
        .from(taskMentions)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, taskMentions.itemId),
                eq(chatterItems.userId, taskMentions.userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .where(
            and(
                inArray(taskMentions.taskId, taskIds),
                linkedTaskMentionCondition(),
            ),
        )
        .orderBy(
            desc(taskMentions.statementAt),
            desc(taskMentions.createdAt),
            asc(taskMentions.id),
        );
    const itemIds = [...new Set(remaining.map((mention) => mention.itemId))];
    const shared = new Set<string>();
    if (input.orgUserId && itemIds.length > 0) {
        const rows = await tx
            .select({ itemId: recordingFolderAssignments.itemId })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    eq(recordingFolders.userId, input.orgUserId),
                    inArray(recordingFolderAssignments.itemId, itemIds),
                ),
            );
        for (const row of rows) shared.add(row.itemId);
    }
    const byTask = new Map<string, RemainingMention[]>();
    for (const mention of remaining) {
        const list = byTask.get(mention.taskId) ?? [];
        list.push(mention);
        byTask.set(mention.taskId, list);
    }
    for (const task of affected) {
        const mentions = byTask.get(task.id) ?? [];
        if (mentions.length === 0) {
            if (input.reason === "withdrawn") continue;
            await tx
                .delete(recordingTasks)
                .where(
                    and(
                        eq(recordingTasks.id, task.id),
                        eq(recordingTasks.userId, task.userId),
                    ),
                );
            continue;
        }
        if (task.itemId !== input.itemId) continue;
        const inScope =
            input.reason === "withdrawn"
                ? mentions.filter(
                      (mention) =>
                          mention.view === "org" && shared.has(mention.itemId),
                  )
                : mentions;
        const next = inScope[0];
        if (!next) {
            if (input.reason === "withdrawn") continue;
            await tx
                .delete(recordingTasks)
                .where(
                    and(
                        eq(recordingTasks.id, task.id),
                        eq(recordingTasks.userId, task.userId),
                    ),
                );
            continue;
        }
        await tx
            .update(recordingTasks)
            .set({
                itemId: next.itemId,
                userId: next.userId,
                quote: next.quote,
                evidenceStartMs: next.evidenceStartMs,
                evidenceSegmentIndex: next.evidenceSegmentIndex,
                evidenceCharStart: next.evidenceCharStart,
                evidenceCharEnd: next.evidenceCharEnd,
                evidenceProvenance: next.provenance,
                updatedAt: now,
            })
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, task.userId),
                ),
            );
        await tx.insert(taskHomeMoves).values({
            taskId: task.id,
            fromItemId: task.itemId,
            toItemId: next.itemId,
            fromUserId: task.userId,
            toUserId: next.userId,
            reason: input.reason,
            actorUserId: input.actorUserId,
            createdAt: now,
        });
    }
    for (const task of affected) {
        const [current] = await tx
            .select({
                id: recordingTasks.id,
                itemId: recordingTasks.itemId,
                userId: recordingTasks.userId,
                assigneePersonId: recordingTasks.assigneePersonId,
            })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    or(
                        eq(recordingTasks.userId, task.userId),
                        inArray(
                            recordingTasks.userId,
                            remaining.map((mention) => mention.userId),
                        ),
                    ),
                ),
            );
        if (!current) continue;
        const proposals = await tx
            .select({
                id: taskUpdateProposals.id,
                kind: taskUpdateProposals.kind,
                state: taskUpdateProposals.state,
                sourceUserId: taskUpdateProposals.userId,
            })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.taskId, current.id),
                    inArray(taskUpdateProposals.state, [
                        "awaiting_share",
                        "awaiting_target_review",
                    ]),
                ),
            );
        if (proposals.length === 0) continue;
        const targetShared = shared.has(current.itemId);
        let assigneeUserId: string | null = null;
        if (current.assigneePersonId) {
            const [person] = await tx
                .select({ email: people.primaryEmail })
                .from(people)
                .where(
                    and(
                        eq(people.id, current.assigneePersonId),
                        or(
                            eq(people.userId, current.userId),
                            input.orgUserId
                                ? eq(people.userId, input.orgUserId)
                                : undefined,
                        ),
                    ),
                );
            if (person?.email) {
                const [assignee] = await tx
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.email, decryptText(person.email)));
                assigneeUserId = assignee?.id ?? null;
            }
        }
        for (const proposal of proposals) {
            if (!targetShared && proposal.sourceUserId !== current.userId) {
                await tx
                    .update(taskUpdateProposals)
                    .set({
                        state: "obsolete",
                        routedTo: null,
                        decidedByUserId: null,
                        decidedAt: now,
                        obsoleteReason: "task_invisible",
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(taskUpdateProposals.id, proposal.id),
                            eq(taskUpdateProposals.taskId, current.id),
                            eq(taskUpdateProposals.state, proposal.state),
                        ),
                    );
                continue;
            }
            if (proposal.state === "awaiting_target_review") {
                const routedTo = new Set([current.userId]);
                if (proposal.kind === "done" && assigneeUserId) {
                    routedTo.add(assigneeUserId);
                }
                await tx
                    .update(taskUpdateProposals)
                    .set({ routedTo: [...routedTo], updatedAt: now })
                    .where(
                        and(
                            eq(taskUpdateProposals.id, proposal.id),
                            eq(taskUpdateProposals.taskId, current.id),
                            eq(
                                taskUpdateProposals.state,
                                "awaiting_target_review",
                            ),
                        ),
                    );
            }
        }
    }
}

/** Remove an item's task data before deleting or wholly erasing the item. */
export async function deleteItemTaskDataInTx(
    tx: Tx,
    input: Omit<MoveInput, "removeMentions" | "reason"> & {
        reason: "deleted" | "erased";
    },
): Promise<void> {
    await moveItemTaskHomesInTx(tx, { ...input, removeMentions: true });
    await tx
        .delete(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, input.itemId),
                eq(taskUpdateProposals.userId, input.ownerUserId),
            ),
        );
    await tx
        .delete(recordingTaskRejections)
        .where(
            and(
                eq(recordingTaskRejections.itemId, input.itemId),
                eq(recordingTaskRejections.userId, input.ownerUserId),
            ),
        );
}

/** Re-home Organization tasks whose home item is being withdrawn. */
export function withdrawItemTaskHomesInTx(
    tx: Tx,
    input: Omit<MoveInput, "removeMentions" | "reason">,
): Promise<void> {
    return moveItemTaskHomesInTx(tx, {
        ...input,
        reason: "withdrawn",
        removeMentions: false,
    });
}
