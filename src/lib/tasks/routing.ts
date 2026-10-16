import {
    and,
    asc,
    eq,
    exists,
    inArray,
    isNull,
    lte,
    or,
    sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
    chatterItems,
    people,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    exportRecordingSidecarsIfEnabled,
    refreshExistingRecordingSidecars,
} from "@/lib/export/document-sidecars";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";
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
    | "earlier_statement"
    | "version_changed"
    | "task_closed"
    | "task_invisible"
    | "rights_lost"
    | "source_withdrawn";

export interface RoutedTaskProposalView {
    id: string;
    kind: ProposalKind;
    sourceItemId: string;
    taskId: string;
    taskText: string;
    dueDate: string | null;
    duePhrase: string | null;
    currentAssigneeName: string | null;
    proposedAssignee: { personId: string; name: string } | null;
    proposedAssigneeHint: string | null;
    proposedAssigneeCheck: boolean;
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    } | null;
    version: number;
    sourceItem: {
        id: string;
        kind: "audio" | "mail";
        title: string;
    } | null;
    attachedBy: { id: string; name: string } | null;
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
    proposedAssigneePersonId: string | null;
    proposedAssigneeHint: string | null;
    proposedAssigneeCheck: boolean;
    statementAt: Date;
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
    assigneeEffectiveAt: Date | null;
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
            assigneeEffectiveAt: recordingTasks.assigneeEffectiveAt,
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

async function assigneeUserId(
    tx: Tx,
    taskId: string,
    ownerUserId: string,
): Promise<string | null> {
    const [assignee] = await tx
        .select({ email: people.primaryEmail })
        .from(recordingTasks)
        .innerJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                eq(recordingTasks.id, taskId),
                eq(recordingTasks.userId, ownerUserId),
            ),
        )
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
        const assignee = await assigneeUserId(
            tx,
            target.taskId,
            target.ownerUserId,
        );
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
    proposal: Pick<
        SourceUpdate,
        | "kind"
        | "dueDate"
        | "duePhrase"
        | "proposedAssigneePersonId"
        | "proposedAssigneeHint"
        | "proposedAssigneeCheck"
    >,
    target: TargetRow,
    actorUserId: string,
    effectiveAt: Date,
): Promise<void> {
    if (proposal.kind === "attach_merge") return;
    const now = new Date();
    const changes =
        proposal.kind === "done" || proposal.kind === "drop"
            ? {
                  status:
                      proposal.kind === "done"
                          ? ("done" as const)
                          : ("dropped" as const),
                  statusChangedAt: now,
                  statusChangedByUserId: actorUserId,
                  statusEffectiveAt: effectiveAt,
                  updatedAt: now,
                  updatedByUserId: actorUserId,
                  version: sql`${recordingTasks.version} + 1`,
              }
            : proposal.kind === "assignee"
              ? {
                    assigneePersonId: proposal.proposedAssigneePersonId,
                    assigneeHint: proposal.proposedAssigneeHint,
                    assigneeCheck: proposal.proposedAssigneeCheck,
                    assignedAt: proposal.proposedAssigneePersonId ? now : null,
                    assigneeEffectiveAt: effectiveAt,
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
                };
    await tx
        .update(recordingTasks)
        .set(changes)
        .where(eq(recordingTasks.id, target.taskId));
}

/** Settles source-review rows superseded by a field's new effective time. */
export async function settleEarlierTaskProposalsInTx(
    tx: Tx,
    input: {
        taskId: string;
        ownerUserId: string;
        kinds: readonly ProposalKind[];
        effectiveAt: Date;
    },
): Promise<void> {
    if (input.kinds.length === 0) return;
    const now = new Date();
    await tx
        .update(taskUpdateProposals)
        .set({
            state: "obsolete",
            routedTo: null,
            decidedByUserId: null,
            decidedAt: now,
            obsoleteReason: "earlier_statement",
            updatedAt: now,
        })
        .where(
            and(
                eq(taskUpdateProposals.taskId, input.taskId),
                eq(taskUpdateProposals.state, "awaiting_source_review"),
                inArray(taskUpdateProposals.kind, input.kinds),
                lte(taskUpdateProposals.statementAt, input.effectiveAt),
                exists(
                    tx
                        .select({ id: recordingTasks.id })
                        .from(recordingTasks)
                        .where(
                            and(
                                eq(recordingTasks.id, input.taskId),
                                eq(recordingTasks.userId, input.ownerUserId),
                            ),
                        ),
                ),
            ),
        );
}

function chronologyAllows(
    proposal: Pick<SourceUpdate, "kind">,
    target: TargetRow,
    statementAt: Date,
): boolean {
    if (proposal.kind === "attach_merge") return true;
    return fieldProposalIsLater(
        statementAt,
        proposal.kind === "done" || proposal.kind === "drop"
            ? target.statusEffectiveAt
            : proposal.kind === "assignee"
              ? target.assigneeEffectiveAt
              : target.dueEffectiveAt,
    );
}

export interface RoutedMergeDifference {
    kind: "attach_merge" | "done" | "due" | "due_phrase";
    dueDate?: string | null;
    duePhrase?: string | null;
    statementAt: Date;
    source: { itemId: string; userId: string };
    mention: {
        itemId: string;
        userId: string;
        quote: string | null;
        evidenceStartMs: number | null;
        evidenceSegmentIndex: number | null;
        evidenceCharStart: number | null;
        evidenceCharEnd: number | null;
        evidenceProvenance: "quoted" | "unverified" | "unlocated" | null;
    } | null;
}

/** Route the differences from a cross-owner task attachment to target editors. */
export async function createRoutedMergeProposalsInTx(
    tx: Tx,
    input: {
        viewer: TaskViewer;
        targetTaskId: string;
        differences: readonly RoutedMergeDifference[];
    },
): Promise<void> {
    if (input.differences.length === 0) return;
    const target = await targetFor(tx, input.viewer, input.targetTaskId);
    if (!target?.visible || target.status !== "open") {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Merge rule: the target must remain a visible open task",
            403,
        );
    }
    const now = new Date();
    for (const difference of input.differences) {
        await tx
            .insert(taskUpdateProposals)
            .values({
                taskId: target.taskId,
                itemId: difference.source.itemId,
                userId: difference.source.userId,
                kind: difference.kind,
                dueDate: difference.dueDate ?? null,
                duePhrase: difference.duePhrase ?? null,
                quote: difference.mention?.quote ?? null,
                evidenceStartMs: difference.mention?.evidenceStartMs ?? null,
                evidenceSegmentIndex:
                    difference.mention?.evidenceSegmentIndex ?? null,
                evidenceCharStart:
                    difference.mention?.evidenceCharStart ?? null,
                evidenceCharEnd: difference.mention?.evidenceCharEnd ?? null,
                evidenceProvenance:
                    difference.mention?.evidenceProvenance ?? null,
                statementAt: difference.statementAt,
                state: "awaiting_target_review",
                routedTo: await routingTargets(tx, difference.kind, target),
                decidedByUserId: input.viewer.userId,
                decidedAt: now,
                ticked: false,
                version: target.version,
                createdAt: now,
                updatedAt: now,
            })
            .onConflictDoNothing();
    }
}

/** Move pending updates from a merged task onto its surviving target. */
export async function movePendingTaskProposalsInTx(
    tx: Tx,
    input: {
        viewer: TaskViewer;
        sourceTaskId: string;
        targetTaskId: string;
    },
): Promise<void> {
    const target = await targetFor(tx, input.viewer, input.targetTaskId);
    if (!target?.visible || target.status !== "open") {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Merge rule: the target must remain a visible open task",
            403,
        );
    }
    const proposals = await tx
        .select({
            id: taskUpdateProposals.id,
            itemId: taskUpdateProposals.itemId,
            userId: taskUpdateProposals.userId,
            kind: taskUpdateProposals.kind,
            state: taskUpdateProposals.state,
            statementAt: taskUpdateProposals.statementAt,
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
                eq(taskUpdateProposals.taskId, input.sourceTaskId),
                inArray(taskUpdateProposals.state, [
                    "awaiting_source_review",
                    "awaiting_share",
                    "awaiting_target_review",
                ]),
            ),
        )
        .orderBy(
            asc(taskUpdateProposals.createdAt),
            asc(taskUpdateProposals.id),
        );
    if (proposals.length === 0) return;
    const conflicts = await tx
        .select({
            itemId: taskUpdateProposals.itemId,
            kind: taskUpdateProposals.kind,
        })
        .from(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.taskId, input.targetTaskId),
                inArray(taskUpdateProposals.state, [
                    "awaiting_source_review",
                    "awaiting_share",
                    "awaiting_target_review",
                ]),
            ),
        );
    const held = new Set(
        conflicts.map((proposal) => `${proposal.itemId}\0${proposal.kind}`),
    );
    for (const proposal of proposals) {
        if (!chronologyAllows(proposal, target, proposal.statementAt)) continue;
        const key = `${proposal.itemId}\0${proposal.kind}`;
        if (held.has(key)) {
            await tx
                .delete(taskUpdateProposals)
                .where(eq(taskUpdateProposals.id, proposal.id));
            continue;
        }
        held.add(key);
        await tx
            .update(taskUpdateProposals)
            .set({
                taskId: target.taskId,
                version: target.version,
                routedTo:
                    proposal.state === "awaiting_target_review"
                        ? await routingTargets(tx, proposal.kind, target)
                        : undefined,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(taskUpdateProposals.id, proposal.id),
                    eq(taskUpdateProposals.taskId, input.sourceTaskId),
                    eq(taskUpdateProposals.state, proposal.state),
                ),
            );
    }
}

/** Settles one source item's accepted and rejected follow-up proposals. */
export async function settleSourceTaskUpdatesInTx(
    tx: Tx,
    input: {
        viewer: TaskViewer;
        sourceItemId: string;
        sourceOwnerUserId: string;
        sourceShared: boolean;
        updates: readonly SourceUpdate[];
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
        const target = await targetFor(tx, input.viewer, proposal.taskId);
        const statementAt = proposal.statementAt;
        if (target && !chronologyAllows(proposal, target, statementAt)) {
            await setProposalState(tx, proposal.id, "obsolete", {
                actorUserId: input.viewer.userId,
                routedTo: null,
                obsoleteReason: "earlier_statement",
            });
            skipped += 1;
            continue;
        }
        if (!proposal.ticked) {
            await setProposalState(tx, proposal.id, "rejected", {
                actorUserId: input.viewer.userId,
                routedTo: null,
            });
            continue;
        }
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
                obsoleteReason: "earlier_statement",
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
        await settleEarlierTaskProposalsInTx(tx, {
            taskId: target.taskId,
            ownerUserId: target.ownerUserId,
            kinds:
                proposal.kind === "done" || proposal.kind === "drop"
                    ? ["done", "drop"]
                    : proposal.kind === "assignee"
                      ? ["assignee"]
                      : ["due", "due_phrase"],
            effectiveAt: statementAt,
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
    const taskIds = [
        ...new Set(proposals.map((proposal) => proposal.taskId)),
    ].sort();
    await tx
        .select({ id: recordingTasks.id })
        .from(recordingTasks)
        .where(inArray(recordingTasks.id, taskIds))
        .orderBy(asc(recordingTasks.id))
        .for("update");
    const lockedProposals = await tx
        .select({
            id: taskUpdateProposals.id,
            kind: taskUpdateProposals.kind,
            taskId: taskUpdateProposals.taskId,
        })
        .from(taskUpdateProposals)
        .where(
            and(
                inArray(
                    taskUpdateProposals.id,
                    proposals.map((proposal) => proposal.id),
                ),
                eq(taskUpdateProposals.itemId, sourceItemId),
                eq(taskUpdateProposals.userId, sourceOwnerUserId),
                eq(taskUpdateProposals.state, "awaiting_share"),
            ),
        );
    const sourceViewer = await taskViewer({
        id: sourceOwnerUserId,
        email: source.email,
    });
    for (const proposal of lockedProposals) {
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

const routedSourceItem = alias(chatterItems, "routed_source_item");
const routedActor = alias(users, "routed_actor");
const routedCurrentAssignee = alias(people, "routed_current_assignee");
const routedProposedAssignee = alias(people, "routed_proposed_assignee");

/** Lists pending target-review changes and attachment notices for this viewer. */
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
            currentAssigneeName: routedCurrentAssignee.displayName,
            proposedAssigneePersonId:
                taskUpdateProposals.proposedAssigneePersonId,
            proposedAssigneeName: routedProposedAssignee.displayName,
            proposedAssigneeHint: taskUpdateProposals.proposedAssigneeHint,
            proposedAssigneeCheck: taskUpdateProposals.proposedAssigneeCheck,
            quote: taskUpdateProposals.quote,
            evidenceStartMs: taskUpdateProposals.evidenceStartMs,
            evidenceSegmentIndex: taskUpdateProposals.evidenceSegmentIndex,
            evidenceCharStart: taskUpdateProposals.evidenceCharStart,
            evidenceCharEnd: taskUpdateProposals.evidenceCharEnd,
            version: taskUpdateProposals.version,
            sourceItemKind: routedSourceItem.kind,
            sourceItemTitle: routedSourceItem.title,
            hasEvidence: exists(
                db
                    .select({ id: taskMentions.id })
                    .from(taskMentions)
                    .where(
                        and(
                            eq(taskMentions.taskId, recordingTasks.id),
                            eq(taskMentions.itemId, taskUpdateProposals.itemId),
                            eq(taskMentions.userId, taskUpdateProposals.userId),
                            eq(taskMentions.view, "org"),
                            inArray(taskMentions.matchDecision, [
                                "home",
                                "accepted",
                            ]),
                            recordingSharedCondition(taskMentions.itemId),
                        ),
                    ),
            ),
            attachedById: routedActor.id,
            attachedByName: routedActor.name,
            attachedByEmail: routedActor.email,
        })
        .from(taskUpdateProposals)
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .leftJoin(
            routedCurrentAssignee,
            eq(routedCurrentAssignee.id, recordingTasks.assigneePersonId),
        )
        .leftJoin(
            routedProposedAssignee,
            eq(
                routedProposedAssignee.id,
                taskUpdateProposals.proposedAssigneePersonId,
            ),
        )
        .innerJoin(
            routedSourceItem,
            and(
                eq(routedSourceItem.id, taskUpdateProposals.itemId),
                eq(routedSourceItem.userId, taskUpdateProposals.userId),
            ),
        )
        .leftJoin(
            routedActor,
            eq(routedActor.id, taskUpdateProposals.decidedByUserId),
        )
        .where(
            and(
                eq(taskUpdateProposals.state, "awaiting_target_review"),
                routedProposalCondition(viewer),
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM),
                isNull(routedSourceItem.deletedAt),
                or(
                    eq(routedSourceItem.userId, viewer.userId),
                    recordingSharedCondition(routedSourceItem.id),
                ),
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
        currentAssigneeName: row.currentAssigneeName
            ? decryptText(row.currentAssigneeName)
            : null,
        proposedAssignee:
            row.proposedAssigneePersonId && row.proposedAssigneeName
                ? {
                      personId: row.proposedAssigneePersonId,
                      name: decryptText(row.proposedAssigneeName),
                  }
                : null,
        proposedAssigneeHint: row.proposedAssigneeHint
            ? decryptText(row.proposedAssigneeHint)
            : null,
        quote: row.quote ? decryptText(row.quote) : null,
        evidenceText:
            row.evidenceSegmentIndex !== null &&
            row.evidenceCharStart !== null &&
            row.evidenceCharEnd !== null
                ? {
                      segmentIndex: row.evidenceSegmentIndex,
                      charStart: row.evidenceCharStart,
                      charEnd: row.evidenceCharEnd,
                  }
                : null,
        sourceItem:
            row.kind === "attach_merge" && !row.hasEvidence
                ? null
                : {
                      id: row.sourceItemId,
                      kind: row.sourceItemKind,
                      title: decryptText(row.sourceItemTitle),
                  },
        attachedBy: row.attachedById
            ? {
                  id: row.attachedById,
                  name:
                      row.attachedByName ??
                      row.attachedByEmail ??
                      row.attachedById,
              }
            : null,
    }));
}

/** Counts every pending routed proposal visible to the viewer. */
export async function countRoutedTaskProposals(
    viewer: TaskViewer,
): Promise<number> {
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskUpdateProposals)
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .innerJoin(
            routedSourceItem,
            and(
                eq(routedSourceItem.id, taskUpdateProposals.itemId),
                eq(routedSourceItem.userId, taskUpdateProposals.userId),
            ),
        )
        .where(
            and(
                eq(taskUpdateProposals.state, "awaiting_target_review"),
                routedProposalCondition(viewer),
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM),
                isNull(routedSourceItem.deletedAt),
                or(
                    eq(routedSourceItem.userId, viewer.userId),
                    recordingSharedCondition(routedSourceItem.id),
                ),
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
    const [authorized] = await db
        .select({ id: taskUpdateProposals.id })
        .from(taskUpdateProposals)
        .innerJoin(
            routedSourceItem,
            and(
                eq(routedSourceItem.id, taskUpdateProposals.itemId),
                eq(routedSourceItem.userId, taskUpdateProposals.userId),
            ),
        )
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                eq(taskUpdateProposals.id, proposalId),
                eq(taskUpdateProposals.itemId, sourceItemId),
                eq(taskUpdateProposals.state, "awaiting_target_review"),
                routedProposalCondition(viewer),
            ),
        )
        .limit(1);
    if (!authorized) {
        throw new AppError(ErrorCode.NOT_FOUND, "Task proposal not found", 404);
    }
    const result = await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
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
                    proposedAssigneePersonId:
                        taskUpdateProposals.proposedAssigneePersonId,
                    proposedAssigneeHint:
                        taskUpdateProposals.proposedAssigneeHint,
                    proposedAssigneeCheck:
                        taskUpdateProposals.proposedAssigneeCheck,
                    quote: taskUpdateProposals.quote,
                    evidenceStartMs: taskUpdateProposals.evidenceStartMs,
                    evidenceSegmentIndex:
                        taskUpdateProposals.evidenceSegmentIndex,
                    evidenceCharStart: taskUpdateProposals.evidenceCharStart,
                    evidenceCharEnd: taskUpdateProposals.evidenceCharEnd,
                    evidenceProvenance: taskUpdateProposals.evidenceProvenance,
                    statementAt: taskUpdateProposals.statementAt,
                    version: taskUpdateProposals.version,
                    routedTo: taskUpdateProposals.routedTo,
                    sourceVisible: sql<boolean>`${and(
                        isNull(chatterItems.deletedAt),
                        or(
                            eq(chatterItems.userId, viewer.userId),
                            recordingSharedCondition(chatterItems.id),
                        ),
                    )}`,
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
            const effectiveAt = proposal.statementAt;
            let reason: ObsoleteProposalReason | null = null;
            const attachmentNotice = proposal.kind === "attach_merge";
            if (!proposal.sourceVisible) reason = "source_withdrawn";
            else if (!target?.visible) reason = "task_invisible";
            else if (target.status !== "open") reason = "task_closed";
            else if (!attachmentNotice && target.version !== proposal.version)
                reason = "version_changed";
            else if (
                !attachmentNotice &&
                !chronologyAllows(proposal, target, effectiveAt)
            )
                reason = "earlier_statement";
            else if (!attachmentNotice && !mayApply(proposal.kind, target))
                reason = "rights_lost";
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
            await applyToTarget(
                tx,
                proposal,
                target,
                viewer.userId,
                effectiveAt,
            );
            await setProposalState(tx, proposal.id, "applied", {
                actorUserId: viewer.userId,
                routedTo: null,
            });
            if (!attachmentNotice) {
                await settleEarlierTaskProposalsInTx(tx, {
                    taskId: target.taskId,
                    ownerUserId: target.ownerUserId,
                    kinds:
                        proposal.kind === "done" || proposal.kind === "drop"
                            ? ["done", "drop"]
                            : proposal.kind === "assignee"
                              ? ["assignee"]
                              : ["due", "due_phrase"],
                    effectiveAt,
                });
            }
            return {
                decision: { state: "applied" as const, obsoleteReason: null },
                changed: attachmentNotice
                    ? null
                    : {
                          ownerUserId: target.ownerUserId,
                          itemId: target.itemId,
                      },
            };
        }),
    );
    if (result.changed) {
        await changed(result.changed.ownerUserId, result.changed.itemId);
    }
    return result.decision;
}

/** Reject a routed change; for `attach_merge`, record dismissal of the notice only. */
export async function rejectRoutedTaskProposal(
    viewer: TaskViewer,
    sourceItemId: string,
    proposalId: string,
): Promise<RoutedProposalDecision> {
    return db.transaction(async (tx) => {
        const [proposal] = await tx
            .select({
                taskId: taskUpdateProposals.taskId,
                kind: taskUpdateProposals.kind,
                routedTo: taskUpdateProposals.routedTo,
                sourceVisible: sql<boolean>`${and(
                    isNull(chatterItems.deletedAt),
                    or(
                        eq(chatterItems.userId, viewer.userId),
                        recordingSharedCondition(chatterItems.id),
                    ),
                )}`,
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
        const target = await targetFor(tx, viewer, proposal.taskId);
        if (!routedDirectlyTo(proposal.routedTo, viewer)) {
            if (!(viewer.isCurator && target?.shared)) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Task proposal not found",
                    404,
                );
            }
        }
        const obsoleteReason = !proposal.sourceVisible
            ? "source_withdrawn"
            : !target?.visible
              ? "task_invisible"
              : null;
        if (obsoleteReason) {
            await setProposalState(tx, proposalId, "obsolete", {
                actorUserId: viewer.userId,
                routedTo: null,
                obsoleteReason,
            });
            return { state: "obsolete", obsoleteReason };
        }
        if (
            !target ||
            (!viewer.isCurator && !mayApply(proposal.kind, target))
        ) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Task proposal not found",
                404,
            );
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
        return { state: "rejected", obsoleteReason: null };
    });
}
