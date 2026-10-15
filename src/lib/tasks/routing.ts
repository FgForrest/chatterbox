import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    people,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    exportRecordingSidecarsIfEnabled,
    refreshExistingRecordingSidecars,
} from "@/lib/export/document-sidecars";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    ANY_TASK_ITEM,
    type TaskViewer,
    taskClosable,
    taskEditable,
    taskRecordingShared,
    taskViewer,
    taskVisible,
} from "@/lib/tasks/access";
import { fieldProposalIsLater } from "@/lib/tasks/chronology";
import { lockItemTaskGraphInTx } from "@/lib/tasks/mentions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProposalKind = (typeof taskUpdateProposals.$inferSelect)["kind"];

export type RoutedProposalState = "applied" | "rejected" | "obsolete";
export type ObsoleteProposalReason =
    | "version_changed"
    | "task_closed"
    | "task_invisible"
    | "rights_lost";

export interface RoutedTaskProposalView {
    id: string;
    kind: ProposalKind;
    sourceItemId: string;
    taskId: string;
    taskText: string;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    version: number;
}

export interface RoutedProposalDecision {
    state: RoutedProposalState;
    obsoleteReason: ObsoleteProposalReason | null;
}

interface SourceUpdate {
    id: string;
    taskId: string;
    kind: ProposalKind;
    dueDate: string | null;
    duePhrase: string | null;
    ticked: boolean;
    version: number;
}

interface TargetRow {
    taskId: string;
    itemId: string;
    ownerUserId: string;
    status: (typeof recordingTasks.$inferSelect)["status"];
    version: number;
    statusEffectiveAt: Date | null;
    dueEffectiveAt: Date | null;
    shared: boolean;
    visible: boolean;
    canEdit: boolean;
    canClose: boolean;
}

function directRecipientCondition(viewer: TaskViewer) {
    return sql`${taskUpdateProposals.routedTo} @> ${JSON.stringify([
        viewer.userId,
    ])}::jsonb`;
}

function routedDirectlyTo(routedTo: unknown, viewer: TaskViewer): boolean {
    return Array.isArray(routedTo) && routedTo.includes(viewer.userId);
}

function routedProposalCondition(viewer: TaskViewer) {
    const direct = directRecipientCondition(viewer);
    return viewer.isCurator
        ? or(direct, taskRecordingShared(viewer, ANY_TASK_ITEM))
        : direct;
}

function mayApply(kind: ProposalKind, target: TargetRow): boolean {
    return kind === "done" ? target.canClose : target.canEdit;
}

async function targetFor(
    tx: Tx,
    viewer: TaskViewer,
    taskId: string,
): Promise<TargetRow | null> {
    const [target] = await tx
        .select({
            taskId: recordingTasks.id,
            itemId: recordingTasks.itemId,
            ownerUserId: chatterItems.userId,
            status: recordingTasks.status,
            version: recordingTasks.version,
            statusEffectiveAt: recordingTasks.statusEffectiveAt,
            dueEffectiveAt: recordingTasks.dueEffectiveAt,
            shared: sql<boolean>`${taskRecordingShared(viewer, ANY_TASK_ITEM)}`,
            visible: sql<boolean>`${and(
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM),
            )}`,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
            canClose: sql<boolean>`${taskClosable(viewer, ANY_TASK_ITEM)}`,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(eq(recordingTasks.id, taskId))
        .limit(1);
    return target ?? null;
}

async function assigneeUserId(tx: Tx, taskId: string): Promise<string | null> {
    const [assignee] = await tx
        .select({ email: people.primaryEmail })
        .from(recordingTasks)
        .innerJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(eq(recordingTasks.id, taskId))
        .limit(1);
    if (!assignee?.email) return null;
    const email = decryptText(assignee.email);
    const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    return user?.id ?? null;
}

async function routingTargets(
    tx: Tx,
    kind: ProposalKind,
    target: TargetRow,
): Promise<string[]> {
    const ids = new Set([target.ownerUserId]);
    if (kind === "done") {
        const assignee = await assigneeUserId(tx, target.taskId);
        if (assignee) ids.add(assignee);
    }
    return [...ids];
}

async function setProposalState(
    tx: Tx,
    proposalId: string,
    state: RoutedProposalState | "awaiting_share" | "awaiting_target_review",
    input: {
        actorUserId: string;
        routedTo?: string[] | null;
        obsoleteReason?: ObsoleteProposalReason | null;
    },
): Promise<void> {
    await tx
        .update(taskUpdateProposals)
        .set({
            state,
            routedTo: input.routedTo,
            decidedByUserId: input.actorUserId,
            decidedAt: new Date(),
            obsoleteReason: input.obsoleteReason ?? null,
            updatedAt: new Date(),
        })
        .where(eq(taskUpdateProposals.id, proposalId));
}

async function applyToTarget(
    tx: Tx,
    proposal: Pick<SourceUpdate, "kind" | "dueDate" | "duePhrase">,
    target: TargetRow,
    actorUserId: string,
    effectiveAt: Date,
): Promise<void> {
    const now = new Date();
    await tx
        .update(recordingTasks)
        .set(
            proposal.kind === "done"
                ? {
                      status: "done",
                      statusChangedAt: now,
                      statusChangedByUserId: actorUserId,
                      statusEffectiveAt: effectiveAt,
                      updatedAt: now,
                      updatedByUserId: actorUserId,
                      version: sql`${recordingTasks.version} + 1`,
                  }
                : {
                      dueDate: proposal.dueDate,
                      duePhrase: proposal.duePhrase,
                      dueEffectiveAt: effectiveAt,
                      updatedAt: now,
                      updatedByUserId: actorUserId,
                      version: sql`${recordingTasks.version} + 1`,
                  },
        )
        .where(eq(recordingTasks.id, target.taskId));
}

function chronologyAllows(
    proposal: Pick<SourceUpdate, "kind">,
    target: TargetRow,
    statementAt: Date,
): boolean {
    return fieldProposalIsLater(
        statementAt,
        proposal.kind === "done"
            ? target.statusEffectiveAt
            : target.dueEffectiveAt,
    );
}

/** Settles one source item's accepted and rejected follow-up proposals. */
export async function settleSourceTaskUpdatesInTx(
    tx: Tx,
    input: {
        viewer: TaskViewer;
        sourceItemId: string;
        sourceOwnerUserId: string;
        sourceShared: boolean;
        sourceOccurredAt: Date;
        updates: readonly SourceUpdate[];
        statementAtByTask: ReadonlyMap<string, Date>;
    },
): Promise<{
    applied: number;
    skipped: number;
    acceptedTaskIds: Set<string>;
    touched: Map<string, string>;
}> {
    let applied = 0;
    let skipped = 0;
    const acceptedTaskIds = new Set<string>();
    const touched = new Map<string, string>();
    for (const proposal of input.updates) {
        if (!proposal.ticked) {
            await setProposalState(tx, proposal.id, "rejected", {
                actorUserId: input.viewer.userId,
                routedTo: null,
            });
            continue;
        }
        const target = await targetFor(tx, input.viewer, proposal.taskId);
        const statementAt =
            input.statementAtByTask.get(proposal.taskId) ??
            input.sourceOccurredAt;
        if (!target?.visible) {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: input.viewer.userId,
                routedTo: null,
                obsoleteReason: "task_invisible",
            });
            skipped += 1;
            continue;
        }
        if (target.status !== "open") {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: input.viewer.userId,
                routedTo: null,
                obsoleteReason: "task_closed",
            });
            skipped += 1;
            continue;
        }
        if (target.version !== proposal.version) {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: input.viewer.userId,
                routedTo: null,
                obsoleteReason: "version_changed",
            });
            skipped += 1;
            continue;
        }
        if (!chronologyAllows(proposal, target, statementAt)) {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: input.viewer.userId,
                routedTo: null,
                obsoleteReason: "version_changed",
            });
            skipped += 1;
            continue;
        }
        acceptedTaskIds.add(proposal.taskId);
        if (!input.sourceShared && target.shared) {
            await setProposalState(tx, proposal.id, "awaiting_share", {
                actorUserId: input.viewer.userId,
                routedTo: null,
            });
            continue;
        }
        if (!mayApply(proposal.kind, target)) {
            await setProposalState(tx, proposal.id, "awaiting_target_review", {
                actorUserId: input.viewer.userId,
                routedTo: await routingTargets(tx, proposal.kind, target),
            });
            continue;
        }
        await applyToTarget(
            tx,
            proposal,
            target,
            input.viewer.userId,
            statementAt,
        );
        await setProposalState(tx, proposal.id, "applied", {
            actorUserId: input.viewer.userId,
            routedTo: null,
        });
        touched.set(target.itemId, target.ownerUserId);
        applied += 1;
    }
    return { applied, skipped, acceptedTaskIds, touched };
}

/** Routes proposals that were held until their private source became shared. */
export async function routeAwaitingShareTaskProposalsInTx(
    tx: Tx,
    sourceItemId: string,
): Promise<void> {
    const [source] = await tx
        .select({ ownerUserId: chatterItems.userId, email: users.email })
        .from(chatterItems)
        .innerJoin(users, eq(users.id, chatterItems.userId))
        .where(eq(chatterItems.id, sourceItemId))
        .limit(1);
    if (!source) return;
    const sourceOwnerUserId = source.ownerUserId;
    await tx
        .update(taskMentions)
        .set({ view: "org", updatedAt: new Date() })
        .where(
            and(
                eq(taskMentions.itemId, sourceItemId),
                eq(taskMentions.userId, sourceOwnerUserId),
                eq(taskMentions.view, "private"),
            ),
        );
    const proposals = await tx
        .select({
            id: taskUpdateProposals.id,
            kind: taskUpdateProposals.kind,
            taskId: taskUpdateProposals.taskId,
        })
        .from(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, sourceItemId),
                eq(taskUpdateProposals.userId, sourceOwnerUserId),
                eq(taskUpdateProposals.state, "awaiting_share"),
            ),
        );
    if (proposals.length === 0) return;
    const sourceViewer = await taskViewer({
        id: sourceOwnerUserId,
        email: source.email,
    });
    for (const proposal of proposals) {
        const target = await targetFor(tx, sourceViewer, proposal.taskId);
        if (!target?.visible) {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: sourceOwnerUserId,
                routedTo: null,
                obsoleteReason: "task_invisible",
            });
            continue;
        }
        await tx
            .update(taskUpdateProposals)
            .set({
                state: "awaiting_target_review",
                routedTo: await routingTargets(tx, proposal.kind, target),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(taskUpdateProposals.id, proposal.id),
                    eq(taskUpdateProposals.itemId, sourceItemId),
                    eq(taskUpdateProposals.userId, sourceOwnerUserId),
                    eq(taskUpdateProposals.state, "awaiting_share"),
                ),
            );
    }
}

/** Lists pending target-review proposals routed to this viewer. */
export async function listRoutedTaskProposals(
    viewer: TaskViewer,
): Promise<RoutedTaskProposalView[]> {
    const rows = await db
        .select({
            id: taskUpdateProposals.id,
            kind: taskUpdateProposals.kind,
            sourceItemId: taskUpdateProposals.itemId,
            taskId: recordingTasks.id,
            taskText: recordingTasks.text,
            dueDate: taskUpdateProposals.dueDate,
            duePhrase: taskUpdateProposals.duePhrase,
            quote: taskUpdateProposals.quote,
            version: taskUpdateProposals.version,
        })
        .from(taskUpdateProposals)
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                eq(taskUpdateProposals.state, "awaiting_target_review"),
                routedProposalCondition(viewer),
            ),
        )
        .orderBy(
            asc(taskUpdateProposals.updatedAt),
            asc(taskUpdateProposals.id),
        );
    return rows.map((row) => ({
        ...row,
        taskText: decryptText(row.taskText),
        duePhrase: row.duePhrase ? decryptText(row.duePhrase) : null,
        quote: row.quote ? decryptText(row.quote) : null,
    }));
}

/** Counts pending routed proposals newer than the viewer's badge timestamp. */
export async function countRoutedTaskProposals(
    viewer: TaskViewer,
    since: Date | null,
): Promise<number> {
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskUpdateProposals)
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                eq(taskUpdateProposals.state, "awaiting_target_review"),
                since ? gt(taskUpdateProposals.updatedAt, since) : undefined,
                routedProposalCondition(viewer),
            ),
        );
    return row?.count ?? 0;
}

async function changed(ownerUserId: string, itemId: string): Promise<void> {
    await notifyIfShared(itemId);
    await refreshExistingRecordingSidecars(ownerUserId, itemId);
    await exportRecordingSidecarsIfEnabled(ownerUserId, itemId, "summary");
}

/** Applies a routed proposal, or records why its authorization became stale. */
export async function applyRoutedTaskProposal(
    viewer: TaskViewer,
    sourceItemId: string,
    proposalId: string,
): Promise<RoutedProposalDecision> {
    const result = await db.transaction(async (tx) => {
        const [source] = await tx
            .select({
                itemId: taskUpdateProposals.itemId,
                ownerUserId: taskUpdateProposals.userId,
            })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.id, proposalId),
                    eq(taskUpdateProposals.itemId, sourceItemId),
                ),
            )
            .limit(1);
        if (!source) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Task proposal not found",
                404,
            );
        }
        await lockItemTaskGraphInTx(tx, {
            itemId: source.itemId,
            ownerUserId: source.ownerUserId,
        });
        const [proposal] = await tx
            .select({
                id: taskUpdateProposals.id,
                taskId: taskUpdateProposals.taskId,
                kind: taskUpdateProposals.kind,
                dueDate: taskUpdateProposals.dueDate,
                duePhrase: taskUpdateProposals.duePhrase,
                version: taskUpdateProposals.version,
                routedTo: taskUpdateProposals.routedTo,
                sourceOccurredAt: chatterItems.occurredAt,
            })
            .from(taskUpdateProposals)
            .innerJoin(
                chatterItems,
                and(
                    eq(chatterItems.id, taskUpdateProposals.itemId),
                    eq(chatterItems.userId, taskUpdateProposals.userId),
                ),
            )
            .where(
                and(
                    eq(taskUpdateProposals.id, proposalId),
                    eq(taskUpdateProposals.itemId, source.itemId),
                    eq(taskUpdateProposals.userId, source.ownerUserId),
                    eq(taskUpdateProposals.state, "awaiting_target_review"),
                    viewer.isCurator
                        ? undefined
                        : directRecipientCondition(viewer),
                ),
            )
            .limit(1);
        if (!proposal) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Task proposal not found",
                404,
            );
        }
        const target = await targetFor(tx, viewer, proposal.taskId);
        const directlyRouted = routedDirectlyTo(proposal.routedTo, viewer);
        if (!directlyRouted && !(viewer.isCurator && target?.shared)) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Task proposal not found",
                404,
            );
        }
        let reason: ObsoleteProposalReason | null = null;
        if (!target?.visible) reason = "task_invisible";
        else if (target.status !== "open") reason = "task_closed";
        else if (target.version !== proposal.version)
            reason = "version_changed";
        else if (!mayApply(proposal.kind, target)) reason = "rights_lost";
        if (reason || !target) {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: viewer.userId,
                routedTo: null,
                obsoleteReason: reason ?? "task_invisible",
            });
            return {
                decision: {
                    state: "obsolete" as const,
                    obsoleteReason: reason ?? "task_invisible",
                },
                changed: null,
            };
        }
        const [mention] = await tx
            .select({ statementAt: taskMentions.statementAt })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.taskId, proposal.taskId),
                    eq(taskMentions.itemId, source.itemId),
                    eq(taskMentions.userId, source.ownerUserId),
                    inArray(taskMentions.matchDecision, ["accepted", "home"]),
                ),
            )
            .limit(1);
        await applyToTarget(
            tx,
            proposal,
            target,
            viewer.userId,
            mention?.statementAt ?? proposal.sourceOccurredAt,
        );
        await setProposalState(tx, proposal.id, "applied", {
            actorUserId: viewer.userId,
            routedTo: null,
        });
        return {
            decision: { state: "applied" as const, obsoleteReason: null },
            changed: { ownerUserId: target.ownerUserId, itemId: target.itemId },
        };
    });
    if (result.changed) {
        await changed(result.changed.ownerUserId, result.changed.itemId);
    }
    return result.decision;
}

/** Rejects a routed proposal as one of its current target editors. */
export async function rejectRoutedTaskProposal(
    viewer: TaskViewer,
    sourceItemId: string,
    proposalId: string,
): Promise<RoutedProposalDecision> {
    await db.transaction(async (tx) => {
        const [proposal] = await tx
            .select({
                taskId: taskUpdateProposals.taskId,
                routedTo: taskUpdateProposals.routedTo,
            })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.id, proposalId),
                    eq(taskUpdateProposals.itemId, sourceItemId),
                    eq(taskUpdateProposals.state, "awaiting_target_review"),
                    viewer.isCurator
                        ? undefined
                        : directRecipientCondition(viewer),
                ),
            )
            .limit(1);
        if (!proposal) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Task proposal not found",
                404,
            );
        }
        if (!routedDirectlyTo(proposal.routedTo, viewer)) {
            const target = await targetFor(tx, viewer, proposal.taskId);
            if (!(viewer.isCurator && target?.shared)) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Task proposal not found",
                    404,
                );
            }
        }
        await tx
            .update(taskUpdateProposals)
            .set({
                state: "rejected",
                routedTo: null,
                decidedByUserId: viewer.userId,
                decidedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(taskUpdateProposals.id, proposalId),
                    eq(taskUpdateProposals.itemId, sourceItemId),
                    eq(taskUpdateProposals.state, "awaiting_target_review"),
                ),
            );
    });
    return { state: "rejected", obsoleteReason: null };
}
