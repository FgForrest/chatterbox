import {
    and,
    asc,
    desc,
    eq,
    gt,
    gte,
    inArray,
    isNull,
    lt,
    lte,
    ne,
    not,
    notExists,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { reviewableTaskTargetCondition } from "@/db/queries/tasks";
import {
    chatterItems,
    type EvidenceProvenance,
    people,
    recordings,
    recordingTaskRejections,
    recordingTasks,
    type TaskUpdateProposalKind,
    taskMentions,
    taskUpdateProposals,
    userSettings,
} from "@/db/schema";
import { type Keyset, keysetBefore, keysetOrder } from "@/lib/db/keyset";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    exportRecordingSidecarsIfEnabled,
    refreshExistingRecordingSidecars,
} from "@/lib/export/document-sidecars";
import { folderCondition } from "@/lib/folders/condition";
import { nudge } from "@/lib/jobs/nudge";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";
import { assertOrgScopeWritable } from "@/lib/org/config";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    ANY_TASK_ITEM,
    assignedToViewer,
    mayMergeTaskOwners,
    type TaskViewer,
    taskClosable,
    taskEditable,
    taskListed,
    taskRecordingShared,
    taskVisible,
} from "@/lib/tasks/access";
import { fieldProposalIsLater } from "@/lib/tasks/chronology";
import {
    type LoadedTaskMentions,
    loadVisibleTaskMentions,
    lockItemTaskGraphInTx,
} from "@/lib/tasks/mentions";
import { taskFingerprint } from "@/lib/tasks/proposals";
import {
    countRoutedTaskProposals,
    createRoutedMergeProposalsInTx,
    movePendingTaskProposalsInTx,
    type RoutedMergeDifference,
    settleEarlierTaskProposalsInTx,
    settleSourceTaskUpdatesInTx,
} from "@/lib/tasks/routing";
import { isoDateOrNull } from "@/lib/tasks/summary-items";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TaskStatus = "proposed" | "open" | "done" | "dropped";

const MAX_TEXT = 500;
const LIST_LIMIT = 200;

/** A task or proposal as the client gets it. */
export interface TaskView {
    id: string;
    recordingId: string;
    evidenceItemId: string;
    evidenceItemKind: "audio" | "mail";
    status: TaskStatus;
    text: string;
    assignee: { personId: string; name: string } | null;
    assigneeHint: string | null;
    assigneeCheck: boolean;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    /** Where in a mail the quote is: a range of one segment's text. */
    evidenceText: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    } | null;
    /**
     * The quote is from a quoted part, from an unverified sender, or was
     * not found in a mail with quoted parts.
     */
    evidenceProvenance: EvidenceProvenance | null;
    source: "riffado" | "plaud" | "manual";
    ticked: boolean;
    version: number;
    createdAt: string;
    acceptedAt: string | null;
    statusChangedAt: string | null;
    /** The viewer may change it (text, assignee, due, drop). */
    canEdit: boolean;
    /** The viewer may mark it done or open again. */
    canClose: boolean;
    /** This row is linked from the current item and that link may be undone. */
    canUndoMatch: boolean;
}

/** A follow-up heard on a recording, about a task of another. */
export interface TaskUpdateView {
    id: string;
    kind: TaskUpdateProposalKind;
    dueDate: string | null;
    duePhrase: string | null;
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
    /** As on a task proposal of a mail. */
    evidenceProvenance: EvidenceProvenance | null;
    /** Informational only: a newer statement already set this field. */
    earlierMention: boolean;
    ticked: boolean;
    version: number;
    task: {
        id: string;
        recordingId: string;
        recordingTitle: string;
        text: string;
        dueDate: string | null;
        duePhrase: string | null;
        assigneeName: string | null;
    };
}

/** An undecided identity match shown in an item's task review. */
export interface TaskMatchView {
    id: string;
    ticked: boolean;
    version: number;
    ambiguous: boolean;
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    } | null;
    evidenceProvenance: EvidenceProvenance | null;
    candidate: {
        id: string;
        status: TaskStatus;
        text: string;
        assignee: { personId: string; name: string } | null;
        dueDate: string | null;
        duePhrase: string | null;
        homeItem: {
            id: string;
            kind: "audio" | "mail";
            title: string;
        };
    };
}

export interface RecordingTasks {
    /** The viewer reviews and edits this recording's tasks. */
    canEdit: boolean;
    /**
     * Its tasks were reviewed at least once (something was accepted or
     * rejected): the summary's own action items no longer stand for them.
     */
    reviewed: boolean;
    tasks: TaskView[];
    /** Waiting for review; only its reviewer sees them. */
    proposals: TaskView[];
    updates: TaskUpdateView[];
    matches: TaskMatchView[];
}

function notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Task not found", 404);
}

function forbidden(): AppError {
    return new AppError(
        ErrorCode.FORBIDDEN,
        "You may not change this task",
        403,
    );
}

function versionConflict(): AppError {
    return new AppError(
        ErrorCode.CONFLICT,
        "The task changed meanwhile; reload it",
        409,
    );
}

function decryptOptional(value: string | null | undefined): string | null {
    return value ? decryptText(value) : null;
}

/**
 * After a task changed: tell the Organization's open tabs, and bring the
 * recording's Markdown exports (which list its tasks) up to date.
 */
async function tasksChanged(
    ownerUserId: string,
    recordingId: string,
): Promise<void> {
    await notifyIfShared(recordingId);
    await refreshExistingRecordingSidecars(ownerUserId, recordingId);
    await exportRecordingSidecarsIfEnabled(ownerUserId, recordingId, "summary");
}

function iso(value: Date | null): string | null {
    return value ? value.toISOString() : null;
}

const taskColumns = {
    id: recordingTasks.id,
    recordingId: recordingTasks.itemId,
    status: recordingTasks.status,
    text: recordingTasks.text,
    assigneePersonId: recordingTasks.assigneePersonId,
    assigneeName: people.displayName,
    assigneeHint: recordingTasks.assigneeHint,
    assigneeCheck: recordingTasks.assigneeCheck,
    dueDate: recordingTasks.dueDate,
    duePhrase: recordingTasks.duePhrase,
    quote: recordingTasks.quote,
    evidenceStartMs: recordingTasks.evidenceStartMs,
    evidenceSegmentIndex: recordingTasks.evidenceSegmentIndex,
    evidenceCharStart: recordingTasks.evidenceCharStart,
    evidenceCharEnd: recordingTasks.evidenceCharEnd,
    evidenceProvenance: recordingTasks.evidenceProvenance,
    homeItemKind: chatterItems.kind,
    source: recordingTasks.source,
    ticked: recordingTasks.ticked,
    version: recordingTasks.version,
    createdAt: recordingTasks.createdAt,
    acceptedAt: recordingTasks.acceptedAt,
    statusChangedAt: recordingTasks.statusChangedAt,
};

type TaskSelect = {
    [K in keyof typeof taskColumns]:
        | (typeof taskColumns)[K]["_"]["data"]
        | null;
};

function toView(
    row: TaskSelect & { canEdit: boolean; canClose: boolean },
    mentions?: LoadedTaskMentions,
    undoableTaskIds: ReadonlySet<string> = new Set(),
): TaskView {
    const taskId = row.id as string;
    const mention = mentions?.latest.get(taskId);
    const legacy = !mentions?.taskIdsWithMentions.has(taskId);
    return {
        id: taskId,
        recordingId: row.recordingId as string,
        evidenceItemId: mention?.itemId ?? (row.recordingId as string),
        evidenceItemKind:
            mention?.kind ?? (row.homeItemKind as "audio" | "mail"),
        status: row.status as TaskStatus,
        text: decryptText(row.text as string),
        assignee:
            row.assigneePersonId && row.assigneeName
                ? {
                      personId: row.assigneePersonId,
                      name: decryptText(row.assigneeName),
                  }
                : null,
        assigneeHint: decryptOptional(row.assigneeHint),
        assigneeCheck: row.assigneeCheck === true,
        dueDate: row.dueDate,
        duePhrase: decryptOptional(row.duePhrase),
        quote: mention?.quote ?? (legacy ? decryptOptional(row.quote) : null),
        evidenceStartMs:
            mention?.evidenceStartMs ?? (legacy ? row.evidenceStartMs : null),
        evidenceText:
            (mention?.evidenceSegmentIndex ??
                (legacy ? row.evidenceSegmentIndex : null)) !== null &&
            (mention?.evidenceCharStart ??
                (legacy ? row.evidenceCharStart : null)) !== null &&
            (mention?.evidenceCharEnd ??
                (legacy ? row.evidenceCharEnd : null)) !== null
                ? {
                      segmentIndex: (mention?.evidenceSegmentIndex ??
                          row.evidenceSegmentIndex) as number,
                      charStart: (mention?.evidenceCharStart ??
                          row.evidenceCharStart) as number,
                      charEnd: (mention?.evidenceCharEnd ??
                          row.evidenceCharEnd) as number,
                  }
                : null,
        evidenceProvenance:
            mention?.provenance ??
            (legacy ? (row.evidenceProvenance ?? null) : null),
        source: row.source as TaskView["source"],
        ticked: row.ticked === true,
        version: row.version ?? 0,
        createdAt: (row.createdAt as Date).toISOString(),
        acceptedAt: iso(row.acceptedAt),
        statusChangedAt: iso(row.statusChangedAt),
        canEdit: row.canEdit,
        canClose: row.canClose,
        canUndoMatch: undoableTaskIds.has(taskId),
    };
}

/** The assignee's name, from a person of the owner's or the Organization's. */
function assigneeJoin() {
    return eq(people.id, recordingTasks.assigneePersonId);
}

/**
 * A recording's tasks as `viewer` sees them: everyone who sees the
 * recording sees its tasks; its reviewer also the proposals waiting.
 * Null when the viewer may not see the recording.
 */
export async function listRecordingTasks(
    viewer: TaskViewer,
    recordingId: string,
): Promise<RecordingTasks | null> {
    const [recording] = await db
        .select({
            id: chatterItems.id,
            ownerUserId: chatterItems.userId,
            kind: chatterItems.kind,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
            shared: sql<boolean>`${taskRecordingShared(viewer, ANY_TASK_ITEM)}`,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM),
            ),
        )
        .limit(1);
    if (!recording) return null;

    const linkedMentions = await db
        .select({
            id: taskMentions.id,
            taskId: taskMentions.taskId,
            itemId: taskMentions.itemId,
            quote: taskMentions.quote,
            evidenceStartMs: taskMentions.evidenceStartMs,
            evidenceSegmentIndex: taskMentions.evidenceSegmentIndex,
            evidenceCharStart: taskMentions.evidenceCharStart,
            evidenceCharEnd: taskMentions.evidenceCharEnd,
            provenance: taskMentions.provenance,
            statementAt: taskMentions.statementAt,
        })
        .from(taskMentions)
        .where(
            and(
                eq(taskMentions.itemId, recordingId),
                eq(taskMentions.userId, recording.ownerUserId),
                eq(taskMentions.matchDecision, "accepted"),
                eq(taskMentions.view, recording.shared ? "org" : "private"),
            ),
        );
    const linkedTaskIds = linkedMentions.map((mention) => mention.taskId);

    const rows = await db
        .select({
            ...taskColumns,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
            canClose: sql<boolean>`${taskClosable(viewer, ANY_TASK_ITEM)}`,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .leftJoin(people, assigneeJoin())
        .where(
            and(
                or(
                    eq(recordingTasks.itemId, recordingId),
                    linkedTaskIds.length > 0
                        ? inArray(recordingTasks.id, linkedTaskIds)
                        : undefined,
                ),
                // Again here: the recording may be withdrawn meanwhile.
                taskVisible(viewer, ANY_TASK_ITEM),
                recording.canEdit
                    ? undefined
                    : ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(asc(recordingTasks.position), asc(recordingTasks.createdAt));
    const mentions = await loadVisibleTaskMentions(
        viewer,
        rows.map((row) => row.id),
    );
    for (const mention of linkedMentions) {
        mentions.latest.set(mention.taskId, {
            ...mention,
            kind: recording.kind,
            quote: decryptOptional(mention.quote),
        });
    }
    const undoableTaskIds = recording.canEdit
        ? new Set(linkedTaskIds)
        : new Set<string>();
    const views = rows.map((row) => toView(row, mentions, undoableTaskIds));
    const [rejection] = await db
        .select({ id: recordingTaskRejections.id })
        .from(recordingTaskRejections)
        .where(eq(recordingTaskRejections.itemId, recordingId))
        .limit(1);

    const [updates, matches] = recording.canEdit
        ? await Promise.all([
              listUpdateProposals(viewer, recordingId, recording.ownerUserId),
              listSuggestedMatches(
                  viewer,
                  recordingId,
                  recording.ownerUserId,
                  recording.shared ? "org" : "private",
                  views.filter((task) => task.status === "proposed"),
              ),
          ])
        : [[], []];
    return {
        canEdit: recording.canEdit,
        reviewed:
            rejection !== undefined ||
            views.some((task) => task.status !== "proposed"),
        tasks: views.filter((task) => task.status !== "proposed"),
        proposals: views.filter((task) => task.status === "proposed"),
        updates,
        matches,
    };
}

/** Undo an accepted match without reverting task fields already applied. */
export async function undoTaskMatch(
    viewer: TaskViewer,
    itemId: string,
    taskId: string,
): Promise<void> {
    const [item] = await db
        .select({
            ownerUserId: chatterItems.userId,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM),
            ),
        )
        .limit(1);
    if (!item?.canEdit) throw notFound();

    await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            await lockItemTaskGraphInTx(tx, {
                itemId,
                ownerUserId: item.ownerUserId,
            });
            const [mention] = await tx
                .select({
                    id: taskMentions.id,
                    decision: taskMentions.matchDecision,
                })
                .from(taskMentions)
                .innerJoin(
                    recordingTasks,
                    eq(recordingTasks.id, taskMentions.taskId),
                )
                .innerJoin(
                    chatterItems,
                    eq(chatterItems.id, recordingTasks.itemId),
                )
                .where(
                    and(
                        eq(taskMentions.itemId, itemId),
                        eq(taskMentions.userId, item.ownerUserId),
                        eq(taskMentions.taskId, taskId),
                        inArray(taskMentions.matchDecision, [
                            "home",
                            "accepted",
                        ]),
                        taskVisible(viewer, ANY_TASK_ITEM),
                    ),
                )
                .limit(1);
            if (!mention) throw notFound();
            if (mention.decision === "home") {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "A task's home mention cannot be undone; merge or drop the task instead",
                    409,
                );
            }
            const changed = await tx
                .update(taskMentions)
                .set({
                    matchDecision: "undone",
                    ticked: false,
                    decidedByUserId: viewer.userId,
                    decidedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(taskMentions.id, mention.id),
                        eq(taskMentions.itemId, itemId),
                        eq(taskMentions.userId, item.ownerUserId),
                        eq(taskMentions.matchDecision, "accepted"),
                    ),
                )
                .returning({ id: taskMentions.id });
            if (changed.length === 0) throw versionConflict();
        }),
    );
    await refreshExistingRecordingSidecars(item.ownerUserId, itemId);
    await exportRecordingSidecarsIfEnabled(item.ownerUserId, itemId, "summary");
}

const matchCandidateHome = alias(chatterItems, "match_candidate_home");
const proposedUpdateAssignee = alias(people, "proposed_update_assignee");

function evidenceKey(evidence: {
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    } | null;
}): string {
    return JSON.stringify([
        evidence.quote,
        evidence.evidenceStartMs,
        evidence.evidenceText?.segmentIndex ?? null,
        evidence.evidenceText?.charStart ?? null,
        evidence.evidenceText?.charEnd ?? null,
    ]);
}

async function listSuggestedMatches(
    viewer: TaskViewer,
    itemId: string,
    ownerUserId: string,
    view: "private" | "org",
    proposals: readonly TaskView[],
): Promise<TaskMatchView[]> {
    const rows = await db
        .select({
            id: taskMentions.id,
            ticked: taskMentions.ticked,
            quote: taskMentions.quote,
            evidenceStartMs: taskMentions.evidenceStartMs,
            evidenceSegmentIndex: taskMentions.evidenceSegmentIndex,
            evidenceCharStart: taskMentions.evidenceCharStart,
            evidenceCharEnd: taskMentions.evidenceCharEnd,
            evidenceProvenance: taskMentions.provenance,
            taskId: recordingTasks.id,
            taskStatus: recordingTasks.status,
            taskText: recordingTasks.text,
            taskVersion: recordingTasks.version,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            assigneePersonId: recordingTasks.assigneePersonId,
            assigneeName: people.displayName,
            homeItemId: matchCandidateHome.id,
            homeItemKind: matchCandidateHome.kind,
            homeItemTitle: matchCandidateHome.title,
        })
        .from(taskMentions)
        .innerJoin(recordingTasks, eq(recordingTasks.id, taskMentions.taskId))
        .innerJoin(
            matchCandidateHome,
            eq(matchCandidateHome.id, recordingTasks.itemId),
        )
        .leftJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                eq(taskMentions.itemId, itemId),
                eq(taskMentions.userId, ownerUserId),
                eq(taskMentions.view, view),
                eq(taskMentions.matchDecision, "suggested"),
                reviewableTaskTargetCondition(
                    taskMentions.taskId,
                    viewer.userId,
                    viewer.isOrg,
                ),
            ),
        )
        .orderBy(asc(taskMentions.createdAt));
    const matches = rows.map(
        (row): TaskMatchView => ({
            id: row.id,
            ticked: row.ticked,
            version: row.taskVersion,
            ambiguous: false,
            quote: decryptOptional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
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
            evidenceProvenance: row.evidenceProvenance ?? null,
            candidate: {
                id: row.taskId,
                status: row.taskStatus,
                text: decryptText(row.taskText),
                assignee:
                    row.assigneePersonId && row.assigneeName
                        ? {
                              personId: row.assigneePersonId,
                              name: decryptText(row.assigneeName),
                          }
                        : null,
                dueDate: row.dueDate,
                duePhrase: decryptOptional(row.duePhrase),
                homeItem: {
                    id: row.homeItemId,
                    kind: row.homeItemKind,
                    title: decryptText(row.homeItemTitle),
                },
            },
        }),
    );
    const counts = new Map<string, number>();
    for (const match of matches) {
        const key = evidenceKey(match);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keepAsNew = new Set(proposals.map(evidenceKey));
    return matches.map((match) => ({
        ...match,
        ambiguous:
            (counts.get(evidenceKey(match)) ?? 0) > 1 ||
            keepAsNew.has(evidenceKey(match)),
    }));
}

/**
 * The follow-ups heard on a recording, about tasks the viewer can still
 * see: a task's recording withdrawn from the Organization since is no
 * longer the Organization's to read.
 */
async function listUpdateProposals(
    viewer: TaskViewer,
    recordingId: string,
    ownerUserId: string,
): Promise<TaskUpdateView[]> {
    const rows = await db
        .select({
            id: taskUpdateProposals.id,
            kind: taskUpdateProposals.kind,
            dueDate: taskUpdateProposals.dueDate,
            duePhrase: taskUpdateProposals.duePhrase,
            proposedAssigneePersonId:
                taskUpdateProposals.proposedAssigneePersonId,
            proposedAssigneeName: proposedUpdateAssignee.displayName,
            proposedAssigneeHint: taskUpdateProposals.proposedAssigneeHint,
            proposedAssigneeCheck: taskUpdateProposals.proposedAssigneeCheck,
            quote: taskUpdateProposals.quote,
            evidenceStartMs: taskUpdateProposals.evidenceStartMs,
            evidenceSegmentIndex: taskUpdateProposals.evidenceSegmentIndex,
            evidenceCharStart: taskUpdateProposals.evidenceCharStart,
            evidenceCharEnd: taskUpdateProposals.evidenceCharEnd,
            evidenceProvenance: taskUpdateProposals.evidenceProvenance,
            statementAt: taskUpdateProposals.statementAt,
            state: taskUpdateProposals.state,
            obsoleteReason: taskUpdateProposals.obsoleteReason,
            decidedByUserId: taskUpdateProposals.decidedByUserId,
            ticked: taskUpdateProposals.ticked,
            version: taskUpdateProposals.version,
            taskId: recordingTasks.id,
            taskRecordingId: recordingTasks.itemId,
            taskText: recordingTasks.text,
            taskDueDate: recordingTasks.dueDate,
            taskDuePhrase: recordingTasks.duePhrase,
            taskStatus: recordingTasks.status,
            taskStatusEffectiveAt: recordingTasks.statusEffectiveAt,
            taskDueEffectiveAt: recordingTasks.dueEffectiveAt,
            taskAssigneeEffectiveAt: recordingTasks.assigneeEffectiveAt,
            recordingTitle: chatterItems.title,
            assigneeName: people.displayName,
        })
        .from(taskUpdateProposals)
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .leftJoin(people, assigneeJoin())
        .leftJoin(
            proposedUpdateAssignee,
            eq(
                proposedUpdateAssignee.id,
                taskUpdateProposals.proposedAssigneePersonId,
            ),
        )
        .where(
            and(
                eq(taskUpdateProposals.itemId, recordingId),
                eq(taskUpdateProposals.userId, ownerUserId),
                or(
                    eq(taskUpdateProposals.state, "awaiting_source_review"),
                    and(
                        eq(taskUpdateProposals.state, "obsolete"),
                        eq(
                            taskUpdateProposals.obsoleteReason,
                            "earlier_statement",
                        ),
                        isNull(taskUpdateProposals.decidedByUserId),
                    ),
                ),
                reviewableTaskTargetCondition(
                    taskUpdateProposals.taskId,
                    viewer.userId,
                    viewer.isOrg,
                ),
            ),
        )
        .orderBy(asc(taskUpdateProposals.createdAt));
    return rows.map((row) => {
        const earlierMention =
            row.state === "obsolete" ||
            !fieldProposalIsLater(
                row.statementAt,
                row.kind === "done" || row.kind === "drop"
                    ? row.taskStatusEffectiveAt
                    : row.kind === "assignee"
                      ? row.taskAssigneeEffectiveAt
                      : row.taskDueEffectiveAt,
            );
        return {
            id: row.id,
            kind: row.kind,
            dueDate: row.dueDate,
            duePhrase: decryptOptional(row.duePhrase),
            proposedAssignee:
                row.proposedAssigneePersonId && row.proposedAssigneeName
                    ? {
                          personId: row.proposedAssigneePersonId,
                          name: decryptText(row.proposedAssigneeName),
                      }
                    : null,
            proposedAssigneeHint: decryptOptional(row.proposedAssigneeHint),
            proposedAssigneeCheck: row.proposedAssigneeCheck,
            quote: decryptOptional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
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
            evidenceProvenance: row.evidenceProvenance ?? null,
            earlierMention,
            ticked: earlierMention ? false : row.ticked,
            version: row.version,
            task: {
                id: row.taskId,
                recordingId: row.taskRecordingId,
                recordingTitle: decryptText(row.recordingTitle),
                text: decryptText(row.taskText),
                dueDate: row.taskDueDate,
                duePhrase: decryptOptional(row.taskDuePhrase),
                assigneeName: decryptOptional(row.assigneeName),
            },
        };
    });
}

interface LockedTask {
    id: string;
    recordingId: string;
    ownerUserId: string;
    status: TaskStatus;
    text: string;
    version: number;
    canEdit: boolean;
    canClose: boolean;
    shared: boolean;
}

/**
 * Read a task for a change, its recording locked (sharing and withdrawal
 * take the same lock, so who may change it cannot move underneath).
 */
async function lockTask(
    tx: Tx,
    viewer: TaskViewer,
    taskId: string,
): Promise<LockedTask> {
    if ((await taskItemKind(tx, taskId)) === "mail") {
        return lockMailTask(tx, viewer, taskId);
    }
    const [row] = await tx
        .select({
            id: recordingTasks.id,
            recordingId: recordingTasks.itemId,
            ownerUserId: recordings.userId,
            status: recordingTasks.status,
            text: recordingTasks.text,
            version: recordingTasks.version,
            visible: sql<boolean>`${taskVisible(viewer)}`,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            canClose: sql<boolean>`${taskClosable(viewer)}`,
            shared: sql<boolean>`${taskRecordingShared(viewer)}`,
        })
        .from(recordingTasks)
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .where(and(eq(recordingTasks.id, taskId), isNull(recordings.deletedAt)))
        .for("update", { of: recordings })
        .limit(1);
    if (!row?.visible) throw notFound();
    if (row.shared && viewer.isCurator) assertOrgScopeWritable();
    // A proposal is its reviewer's alone.
    if (row.status === "proposed" && !row.canEdit) throw notFound();
    return { ...row, text: decryptText(row.text) };
}

/** What kind of item a task is on. */
async function taskItemKind(
    tx: Tx,
    taskId: string,
): Promise<"audio" | "mail" | null> {
    const [row] = await tx
        .select({ kind: chatterItems.kind })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(eq(recordingTasks.id, taskId))
        .limit(1);
    return row?.kind ?? null;
}

/**
 * `lockTask` for a task on a mail: a mail has no recording row, so its item
 * row is the one locked, as sharing and withdrawal lock it.
 */
async function lockMailTask(
    tx: Tx,
    viewer: TaskViewer,
    taskId: string,
): Promise<LockedTask> {
    const [row] = await tx
        .select({
            id: recordingTasks.id,
            recordingId: recordingTasks.itemId,
            ownerUserId: chatterItems.userId,
            status: recordingTasks.status,
            text: recordingTasks.text,
            version: recordingTasks.version,
            visible: sql<boolean>`${taskVisible(viewer, ANY_TASK_ITEM)}`,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
            canClose: sql<boolean>`${taskClosable(viewer, ANY_TASK_ITEM)}`,
            shared: sql<boolean>`${taskRecordingShared(viewer, ANY_TASK_ITEM)}`,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(eq(recordingTasks.id, taskId), isNull(chatterItems.deletedAt)),
        )
        .for("update", { of: chatterItems })
        .limit(1);
    if (!row?.visible) throw notFound();
    if (row.shared && viewer.isCurator) assertOrgScopeWritable();
    if (row.status === "proposed" && !row.canEdit) throw notFound();
    return { ...row, text: decryptText(row.text) };
}

/** Lock a recording the viewer reviews, refusing anyone else. */
async function lockRecordingForEdit(
    tx: Tx,
    viewer: TaskViewer,
    recordingId: string,
): Promise<{ ownerUserId: string; shared: boolean; occurredAt: Date }> {
    const [recordingRow] = await tx
        .select({
            ownerUserId: recordings.userId,
            occurredAt: chatterItems.occurredAt,
            visible: sql<boolean>`${taskVisible(viewer)}`,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            shared: sql<boolean>`${taskRecordingShared(viewer)}`,
        })
        .from(recordings)
        .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
        .where(
            and(eq(recordings.id, recordingId), isNull(recordings.deletedAt)),
        )
        .for("update", { of: recordings })
        .limit(1);
    // A mail has no recording row: its item row is locked instead.
    const [row] = recordingRow
        ? [recordingRow]
        : await tx
              .select({
                  ownerUserId: chatterItems.userId,
                  occurredAt: chatterItems.occurredAt,
                  visible: sql<boolean>`${taskVisible(viewer, ANY_TASK_ITEM)}`,
                  canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
                  shared: sql<boolean>`${taskRecordingShared(viewer, ANY_TASK_ITEM)}`,
              })
              .from(chatterItems)
              .where(
                  and(
                      eq(chatterItems.id, recordingId),
                      eq(chatterItems.kind, "mail"),
                      isNull(chatterItems.deletedAt),
                  ),
              )
              .for("update")
              .limit(1);
    if (!row?.visible) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    if (row.shared && viewer.isCurator) assertOrgScopeWritable();
    if (!row.canEdit) throw forbidden();
    return row;
}

/**
 * The person a task may be assigned to on a recording, as stored: the
 * survivor of a merge, of the owner's Almanac or the Organization's (on a
 * shared recording the Organization's only, so nothing private surfaces).
 */
async function assignablePerson(
    tx: Tx,
    personId: string,
    { ownerUserId, shared }: { ownerUserId: string; shared: boolean },
    orgUserId: string | null,
): Promise<string> {
    const [row] = await tx
        .select({
            id: people.id,
            userId: people.userId,
            mergedIntoId: people.mergedIntoId,
        })
        .from(people)
        .where(eq(people.id, personId))
        .limit(1);
    if (row?.mergedIntoId) {
        return assignablePerson(
            tx,
            row.mergedIntoId,
            { ownerUserId, shared },
            orgUserId,
        );
    }
    const allowed =
        row &&
        ((orgUserId !== null && row.userId === orgUserId) ||
            (!shared && row.userId === ownerUserId));
    if (!allowed) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "That person cannot be assigned here",
            400,
            { field: "assigneePersonId" },
        );
    }
    return row.id;
}

function cleanText(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    if (!trimmed) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A task needs a text",
            400,
            { field: "text" },
        );
    }
    return trimmed;
}

function cleanDue(value: string | null): string | null {
    if (value === null) return null;
    const date = isoDateOrNull(value);
    if (!date) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A due date is a day, YYYY-MM-DD",
            400,
            { field: "dueDate" },
        );
    }
    return date;
}

export interface NewTask {
    text: string;
    assigneePersonId?: string | null;
    dueDate?: string | null;
    /** `proposed` adds a row to the review; `open` a task at once. */
    status: "proposed" | "open";
}

/** Add a task by hand to a recording the viewer reviews. */
export async function addTask(
    viewer: TaskViewer,
    recordingId: string,
    input: NewTask,
): Promise<TaskView> {
    const text = cleanText(input.text);
    const dueDate = cleanDue(input.dueDate ?? null);
    const id = await db.transaction(async (tx) => {
        const recording = await lockRecordingForEdit(tx, viewer, recordingId);
        const assigneePersonId = input.assigneePersonId
            ? await assignablePerson(
                  tx,
                  input.assigneePersonId,
                  recording,
                  viewer.orgUserId,
              )
            : null;
        const [last] = await tx
            .select({
                position: sql<number | null>`max(${recordingTasks.position})`,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, recordingId));
        const now = new Date();
        const open = input.status === "open";
        const [row] = await tx
            .insert(recordingTasks)
            .values({
                itemId: recordingId,
                userId: recording.ownerUserId,
                status: input.status,
                text: encryptText(text),
                assigneePersonId,
                dueDate,
                source: "manual",
                ticked: true,
                position: (last?.position ?? -1) + 1,
                createdByUserId: viewer.userId,
                acceptedAt: open ? now : null,
                assignedAt: open && assigneePersonId ? now : null,
                acceptedByUserId: open ? viewer.userId : null,
                statusEffectiveAt: open ? recording.occurredAt : null,
                dueEffectiveAt: open ? recording.occurredAt : null,
                assigneeEffectiveAt: open ? recording.occurredAt : null,
                updatedByUserId: viewer.userId,
                originItemId: recordingId,
            })
            .returning({ id: recordingTasks.id });
        if (row) {
            await tx.insert(taskMentions).values({
                taskId: row.id,
                itemId: recordingId,
                userId: recording.ownerUserId,
                view: recording.shared ? "org" : "private",
                statementAt: recording.occurredAt,
                matchDecision: "home",
            });
        }
        return { id: row?.id ?? "", ownerUserId: recording.ownerUserId };
    });
    await tasksChanged(id.ownerUserId, recordingId);
    return requireTaskView(viewer, id.id);
}

export interface TaskChange {
    version: number;
    text?: string;
    assigneePersonId?: string | null;
    dueDate?: string | null;
    /** A proposal's draft tick. */
    ticked?: boolean;
    /** Move an accepted task between open, done and dropped. */
    status?: "open" | "done" | "dropped";
}

/**
 * Change a task or a proposal. Closing and reopening need `canClose`;
 * everything else, dropping included, needs `canEdit`. Refused with 409
 * when someone changed it since `version` was read.
 */
export async function updateTask(
    viewer: TaskViewer,
    taskId: string,
    change: TaskChange,
): Promise<TaskView> {
    const task = await db.transaction(async (tx) => {
        const task = await lockTask(tx, viewer, taskId);
        if (task.version !== change.version) throw versionConflict();

        const editing =
            change.text !== undefined ||
            change.assigneePersonId !== undefined ||
            change.dueDate !== undefined ||
            change.ticked !== undefined ||
            change.status === "dropped" ||
            (change.status !== undefined && task.status === "dropped");
        if (editing && !task.canEdit) throw forbidden();
        if (change.status !== undefined) {
            if (task.status === "proposed") {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Accept the review first",
                    400,
                    { field: "status" },
                );
            }
            if (!task.canEdit && !task.canClose) throw forbidden();
        }
        if (change.ticked !== undefined && task.status !== "proposed") {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Only a proposal is ticked",
                400,
                { field: "ticked" },
            );
        }

        const now = new Date();
        const set: Partial<typeof recordingTasks.$inferInsert> = {
            version: task.version + 1,
            updatedAt: now,
            updatedByUserId: viewer.userId,
        };
        if (change.text !== undefined) {
            const text = cleanText(change.text);
            set.text = encryptText(text);
            // The summary would say it in its old words again.
            if (text !== task.text) {
                await rejectInTx(tx, task, [task.text]);
            }
        }
        if (change.assigneePersonId !== undefined) {
            set.assigneePersonId = change.assigneePersonId
                ? await assignablePerson(
                      tx,
                      change.assigneePersonId,
                      task,
                      viewer.orgUserId,
                  )
                : null;
            set.assigneeHint = null;
            set.assigneeCheck = false;
            set.assigneeEffectiveAt = now;
            // A task, not a proposal: news for whoever it names now.
            if (task.status !== "proposed" && set.assigneePersonId) {
                set.assignedAt = now;
            }
        }
        if (change.dueDate !== undefined) {
            set.dueDate = cleanDue(change.dueDate);
            set.dueEffectiveAt = now;
        }
        if (change.ticked !== undefined) set.ticked = change.ticked;
        if (change.status !== undefined && change.status !== task.status) {
            set.status = change.status;
            set.statusChangedAt = now;
            set.statusChangedByUserId = viewer.userId;
            set.statusEffectiveAt = now;
        }
        await tx
            .update(recordingTasks)
            .set(set)
            .where(eq(recordingTasks.id, taskId));
        if (change.status !== undefined && change.status !== task.status) {
            await settleEarlierTaskProposalsInTx(tx, {
                taskId,
                ownerUserId: task.ownerUserId,
                kinds: ["done", "drop"],
                effectiveAt: now,
            });
        }
        if (change.dueDate !== undefined) {
            await settleEarlierTaskProposalsInTx(tx, {
                taskId,
                ownerUserId: task.ownerUserId,
                kinds: ["due", "due_phrase"],
                effectiveAt: now,
            });
        }
        if (change.assigneePersonId !== undefined) {
            await settleEarlierTaskProposalsInTx(tx, {
                taskId,
                ownerUserId: task.ownerUserId,
                kinds: ["assignee"],
                effectiveAt: now,
            });
        }
        return task;
    });
    await tasksChanged(task.ownerUserId, task.recordingId);
    return requireTaskView(viewer, taskId);
}

async function rejectInTx(
    tx: Tx,
    { recordingId, ownerUserId }: { recordingId: string; ownerUserId: string },
    texts: readonly string[],
): Promise<void> {
    if (texts.length === 0) return;
    await tx
        .insert(recordingTaskRejections)
        .values(
            texts.map((text) => ({
                userId: ownerUserId,
                itemId: recordingId,
                fingerprintHmac: taskFingerprint(text),
            })),
        )
        .onConflictDoNothing();
}

interface MergeTaskRow {
    id: string;
    itemId: string;
    ownerUserId: string;
    status: TaskStatus;
    version: number;
    dueDate: string | null;
    duePhrase: string | null;
    statusEffectiveAt: Date | null;
    dueEffectiveAt: Date | null;
    occurredAt: Date;
    visible: boolean;
    shared: boolean;
}

interface MergeMentionRow {
    id: string;
    taskId: string;
    itemId: string;
    userId: string;
    view: "private" | "org";
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceSegmentIndex: number | null;
    evidenceCharStart: number | null;
    evidenceCharEnd: number | null;
    evidenceProvenance: EvidenceProvenance | null;
    statementAt: Date;
    matchDecision:
        | "home"
        | "suggested"
        | "accepted"
        | "rejected"
        | "undone"
        | "kept_new";
    ticked: boolean;
    shared: boolean;
}

function mergeRule(message: string): AppError {
    return new AppError(ErrorCode.FORBIDDEN, `Merge rule: ${message}`, 403);
}

async function lockMergeTasks(
    tx: Tx,
    viewer: TaskViewer,
    sourceTaskId: string,
    targetTaskId: string,
): Promise<{ source: MergeTaskRow; target: MergeTaskRow }> {
    const ids = [sourceTaskId, targetTaskId].sort();
    const taskRefs = await tx
        .select({
            taskId: recordingTasks.id,
            itemId: chatterItems.id,
            kind: chatterItems.kind,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(inArray(recordingTasks.id, ids));
    if (taskRefs.length !== 2) throw notFound();
    const [mentionRefs, proposalRefs] = await Promise.all([
        tx
            .select({ itemId: taskMentions.itemId })
            .from(taskMentions)
            .where(inArray(taskMentions.taskId, ids)),
        tx
            .select({ itemId: taskUpdateProposals.itemId })
            .from(taskUpdateProposals)
            .where(inArray(taskUpdateProposals.taskId, ids)),
    ]);
    const graphItemIds = [
        ...new Set(
            [...taskRefs, ...mentionRefs, ...proposalRefs].map(
                (row) => row.itemId,
            ),
        ),
    ];
    const refs = await tx
        .select({ itemId: chatterItems.id, kind: chatterItems.kind })
        .from(chatterItems)
        .where(inArray(chatterItems.id, graphItemIds));
    let itemRefs: { itemId: string; kind: "audio" | "mail" }[] = [
        ...new Map(refs.map((row) => [row.itemId, row])).values(),
    ].sort((left, right) => left.itemId.localeCompare(right.itemId));
    const lockItems = async (
        pending: readonly { itemId: string; kind: "audio" | "mail" }[],
    ) => {
        for (const ref of [...pending].sort((left, right) =>
            left.itemId.localeCompare(right.itemId),
        )) {
            if (ref.kind === "audio") {
                await tx
                    .select({ id: recordings.id })
                    .from(recordings)
                    .where(eq(recordings.id, ref.itemId))
                    .for("update");
            } else {
                await tx
                    .select({ id: chatterItems.id })
                    .from(chatterItems)
                    .where(eq(chatterItems.id, ref.itemId))
                    .for("update");
            }
        }
    };
    await lockItems(itemRefs);
    const readTasks = () =>
        tx
            .select({
                id: recordingTasks.id,
                itemId: recordingTasks.itemId,
                ownerUserId: recordingTasks.userId,
                status: recordingTasks.status,
                version: recordingTasks.version,
                dueDate: recordingTasks.dueDate,
                duePhrase: recordingTasks.duePhrase,
                statusEffectiveAt: recordingTasks.statusEffectiveAt,
                dueEffectiveAt: recordingTasks.dueEffectiveAt,
                occurredAt: chatterItems.occurredAt,
                visible: sql<boolean>`${taskVisible(viewer, ANY_TASK_ITEM)}`,
                shared: sql<boolean>`${taskRecordingShared(viewer, ANY_TASK_ITEM)}`,
            })
            .from(recordingTasks)
            .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
            .where(inArray(recordingTasks.id, ids))
            .orderBy(asc(recordingTasks.id))
            .for("update", { of: recordingTasks });
    let rows = await readTasks();
    if (rows.length !== 2) throw notFound();
    const lockedItemIds = new Set(itemRefs.map((ref) => ref.itemId));
    const driftedItemIds = [
        ...new Set(
            rows
                .map((row) => row.itemId)
                .filter((itemId) => !lockedItemIds.has(itemId)),
        ),
    ];
    if (driftedItemIds.length > 0) {
        const driftedRefs = await tx
            .select({ itemId: chatterItems.id, kind: chatterItems.kind })
            .from(chatterItems)
            .where(inArray(chatterItems.id, driftedItemIds))
            .orderBy(asc(chatterItems.id));
        await lockItems(driftedRefs);
        itemRefs = [...itemRefs, ...driftedRefs];
        rows = await readTasks();
        if (rows.length !== 2) throw notFound();
        const relockedItemIds = new Set(itemRefs.map((ref) => ref.itemId));
        if (rows.some((row) => !relockedItemIds.has(row.itemId))) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "A task home changed meanwhile; retry the merge",
                409,
            );
        }
    }
    const normalized = rows.map((row) => ({
        ...row,
        duePhrase: decryptOptional(row.duePhrase),
    }));
    const source = normalized.find((row) => row.id === sourceTaskId);
    const target = normalized.find((row) => row.id === targetTaskId);
    if (!source || !target) throw notFound();
    return { source, target };
}

function linkedMention(mention: MergeMentionRow): boolean {
    return (
        mention.matchDecision === "home" || mention.matchDecision === "accepted"
    );
}

async function collapseMergedMentions(
    tx: Tx,
    input: {
        sourceTaskId: string;
        targetTaskId: string;
        viewerUserId: string;
        mentions: readonly MergeMentionRow[];
        now: Date;
    },
): Promise<void> {
    const groups = new Map<string, MergeMentionRow[]>();
    for (const mention of input.mentions) {
        const key = `${mention.itemId}\0${mention.view}`;
        groups.set(key, [...(groups.get(key) ?? []), mention]);
    }
    for (const mentions of groups.values()) {
        const ordered = [...mentions].sort((left, right) => {
            const priority = (mention: MergeMentionRow) => {
                const onTarget = mention.taskId === input.targetTaskId;
                if (linkedMention(mention)) return onTarget ? 0 : 1;
                if (mention.matchDecision === "suggested") {
                    return onTarget ? 2 : 3;
                }
                return onTarget ? 4 : 5;
            };
            return priority(left) - priority(right);
        });
        const winner = ordered[0];
        if (!winner) continue;
        const losers = ordered.slice(1).map((mention) => mention.id);
        if (losers.length > 0) {
            await tx
                .delete(taskMentions)
                .where(inArray(taskMentions.id, losers));
        }
        const moved = winner.taskId === input.sourceTaskId;
        const acceptedHome = moved && winner.matchDecision === "home";
        const ticked =
            winner.matchDecision === "suggested"
                ? mentions.some(
                      (mention) =>
                          mention.matchDecision === "suggested" &&
                          mention.ticked,
                  )
                : winner.ticked;
        await tx
            .update(taskMentions)
            .set({
                taskId: moved ? input.targetTaskId : winner.taskId,
                matchDecision: acceptedHome ? "accepted" : winner.matchDecision,
                ticked,
                decidedByUserId: acceptedHome ? input.viewerUserId : undefined,
                decidedAt: acceptedHome ? input.now : undefined,
                updatedAt: input.now,
            })
            .where(eq(taskMentions.id, winner.id));
    }
}

function mentionAt(
    mentions: readonly MergeMentionRow[],
    effectiveAt: Date | null,
    fallback: MergeMentionRow,
): MergeMentionRow {
    if (!effectiveAt) return fallback;
    return (
        mentions.find(
            (mention) =>
                mention.statementAt.getTime() === effectiveAt.getTime(),
        ) ?? fallback
    );
}

function mergeDifferences(
    source: MergeTaskRow,
    target: MergeTaskRow,
    mentions: readonly MergeMentionRow[],
): RoutedMergeDifference[] {
    const eligible = mentions.filter(
        (mention) =>
            linkedMention(mention) && mention.view === "org" && mention.shared,
    );
    const home =
        eligible.find((mention) => mention.itemId === source.itemId) ??
        eligible[0] ??
        null;
    const sourceRef = { itemId: source.itemId, userId: source.ownerUserId };
    const baseStatementAt =
        source.statusEffectiveAt ??
        source.dueEffectiveAt ??
        home?.statementAt ??
        source.occurredAt;
    const differences: RoutedMergeDifference[] = [
        {
            kind: "attach_merge",
            source: sourceRef,
            mention: home,
            statementAt: baseStatementAt,
        },
    ];
    if (
        source.status === "done" &&
        target.status === "open" &&
        fieldProposalIsLater(
            source.statusEffectiveAt ?? home?.statementAt ?? source.occurredAt,
            target.statusEffectiveAt,
        )
    ) {
        differences.push({
            kind: "done",
            source: sourceRef,
            mention: home
                ? mentionAt(eligible, source.statusEffectiveAt, home)
                : null,
            statementAt:
                source.statusEffectiveAt ??
                home?.statementAt ??
                source.occurredAt,
        });
    }
    if (
        (source.dueDate !== target.dueDate ||
            source.duePhrase !== target.duePhrase) &&
        fieldProposalIsLater(
            source.dueEffectiveAt ?? home?.statementAt ?? source.occurredAt,
            target.dueEffectiveAt,
        )
    ) {
        if (source.dueDate) {
            differences.push({
                kind: "due",
                dueDate: source.dueDate,
                duePhrase: encryptText(source.duePhrase),
                source: sourceRef,
                mention: home
                    ? mentionAt(eligible, source.dueEffectiveAt, home)
                    : null,
                statementAt:
                    source.dueEffectiveAt ??
                    home?.statementAt ??
                    source.occurredAt,
            });
        } else if (source.duePhrase) {
            differences.push({
                kind: "due_phrase",
                dueDate: null,
                duePhrase: encryptText(source.duePhrase),
                source: sourceRef,
                mention: home
                    ? mentionAt(eligible, source.dueEffectiveAt, home)
                    : null,
                statementAt:
                    source.dueEffectiveAt ??
                    home?.statementAt ??
                    source.occurredAt,
            });
        }
    }
    return differences;
}

/** Merge one task or reviewed proposal into an open target task. */
export async function mergeTaskIntoTask(
    viewer: TaskViewer,
    sourceTaskId: string,
    targetTaskId: string,
    options: { reviewItemId?: string } = {},
): Promise<TaskView & { mergeOwnerNotified: boolean }> {
    if (sourceTaskId === targetTaskId) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A task cannot be merged into itself",
            400,
            { field: "targetTaskId" },
        );
    }
    const visible = await db
        .select({
            id: recordingTasks.id,
            visible: sql<boolean>`${taskVisible(viewer, ANY_TASK_ITEM)}`,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(inArray(recordingTasks.id, [sourceTaskId, targetTaskId]));
    if (visible.length !== 2 || visible.some((task) => !task.visible)) {
        throw notFound();
    }
    const changed = await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            const { source, target } = await lockMergeTasks(
                tx,
                viewer,
                sourceTaskId,
                targetTaskId,
            );
            if (!source.visible || !target.visible) {
                throw mergeRule(
                    "both tasks must be visible to the person merging",
                );
            }
            if (target.status !== "open") {
                throw mergeRule("the target must be an open task");
            }
            if (source.shared && !target.shared) {
                throw mergeRule(
                    "an Organization task can be merged only into an Organization task",
                );
            }
            const proposal = source.status === "proposed";
            if (proposal) {
                if (options.reviewItemId !== source.itemId) {
                    throw mergeRule(
                        "a proposal may be merged only from its item's review",
                    );
                }
                if (
                    source.ownerUserId !== viewer.userId &&
                    !(viewer.isCurator && source.shared)
                ) {
                    throw mergeRule(
                        "only the item's owner or a curator may accept its match",
                    );
                }
            } else if (
                !mayMergeTaskOwners(
                    viewer,
                    source.ownerUserId,
                    target.ownerUserId,
                )
            ) {
                if (target.ownerUserId === viewer.userId) {
                    throw mergeRule(
                        "merging someone else's task into your own requires a curator",
                    );
                }
                if (source.ownerUserId === target.ownerUserId) {
                    throw mergeRule(
                        "only the home owner or a curator may merge that owner's tasks",
                    );
                }
                throw mergeRule(
                    "only the merged task's home owner may attach it to someone else's task",
                );
            }
            if (!source.shared && target.shared) {
                throw mergeRule(
                    "a private task can join an Organization task only after its home item is shared",
                );
            }
            if (viewer.isCurator && (source.shared || target.shared)) {
                assertOrgScopeWritable();
            }
            const mentions = await tx
                .select({
                    id: taskMentions.id,
                    taskId: taskMentions.taskId,
                    itemId: taskMentions.itemId,
                    userId: taskMentions.userId,
                    view: taskMentions.view,
                    quote: taskMentions.quote,
                    evidenceStartMs: taskMentions.evidenceStartMs,
                    evidenceSegmentIndex: taskMentions.evidenceSegmentIndex,
                    evidenceCharStart: taskMentions.evidenceCharStart,
                    evidenceCharEnd: taskMentions.evidenceCharEnd,
                    evidenceProvenance: taskMentions.provenance,
                    statementAt: taskMentions.statementAt,
                    matchDecision: taskMentions.matchDecision,
                    ticked: taskMentions.ticked,
                    shared: sql<boolean>`${recordingSharedCondition(
                        taskMentions.itemId,
                    )}`,
                })
                .from(taskMentions)
                .where(inArray(taskMentions.taskId, [source.id, target.id]))
                .orderBy(desc(taskMentions.statementAt), asc(taskMentions.id));
            const sourceMentions = mentions.filter(
                (mention) => mention.taskId === source.id,
            );
            const now = new Date();
            await movePendingTaskProposalsInTx(tx, {
                viewer,
                sourceTaskId: source.id,
                targetTaskId: target.id,
            });
            if (source.ownerUserId !== target.ownerUserId) {
                await createRoutedMergeProposalsInTx(tx, {
                    viewer,
                    targetTaskId: target.id,
                    differences: mergeDifferences(
                        source,
                        target,
                        sourceMentions,
                    ),
                });
            }
            await collapseMergedMentions(tx, {
                sourceTaskId: source.id,
                targetTaskId: target.id,
                viewerUserId: viewer.userId,
                mentions,
                now,
            });
            await tx
                .delete(recordingTasks)
                .where(
                    and(
                        eq(recordingTasks.id, source.id),
                        eq(recordingTasks.userId, source.ownerUserId),
                    ),
                );
            return {
                sourceItemId: source.itemId,
                sourceOwnerUserId: source.ownerUserId,
                targetItemId: target.itemId,
                targetOwnerUserId: target.ownerUserId,
            };
        }),
    );
    await tasksChanged(changed.sourceOwnerUserId, changed.sourceItemId);
    if (changed.targetItemId !== changed.sourceItemId) {
        await tasksChanged(changed.targetOwnerUserId, changed.targetItemId);
    }
    return {
        ...(await requireTaskView(viewer, targetTaskId)),
        mergeOwnerNotified:
            changed.sourceOwnerUserId !== changed.targetOwnerUserId,
    };
}

/**
 * Fold several proposals of a recording into the first: their texts joined,
 * the first assignee that has one, the earliest due date, the first quote.
 * The others go. Every text merged is remembered as rejected, so the next
 * summary does not split them out again.
 */
export async function mergeProposals(
    viewer: TaskViewer,
    recordingId: string,
    taskIds: readonly string[],
): Promise<TaskView> {
    const ids = [...new Set(taskIds)];
    if (ids.length < 2) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Merge needs two proposals or more",
            400,
            { field: "taskIds" },
        );
    }
    const keepId = await db.transaction(async (tx) => {
        const recording = await lockRecordingForEdit(tx, viewer, recordingId);
        const rows = await tx
            .select()
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, recordingId),
                    eq(recordingTasks.status, "proposed"),
                    inArray(recordingTasks.id, ids),
                ),
            );
        if (rows.length !== ids.length) throw notFound();
        const ordered = ids.map((id) => rows.find((row) => row.id === id));
        const [first, ...rest] = ordered;
        if (!first) throw notFound();
        const texts = ordered.map((row) => decryptText(row?.text ?? ""));
        const assigned = ordered.find((row) => row?.assigneePersonId);
        const hinted = ordered.find((row) => row?.assigneeHint);
        const dues = ordered
            .filter((row) => row?.dueDate)
            .sort((a, b) => (a?.dueDate ?? "").localeCompare(b?.dueDate ?? ""));
        const due = dues[0];
        const quoted = ordered.find((row) => row?.quote);
        const evidence = quoted ?? first;
        await tx
            .update(recordingTasks)
            .set({
                text: encryptText(cleanText(texts.join("; "))),
                assigneePersonId: assigned?.assigneePersonId ?? null,
                assigneeCheck: assigned?.assigneeCheck ?? false,
                assigneeHint: assigned ? null : (hinted?.assigneeHint ?? null),
                dueDate: due?.dueDate ?? null,
                duePhrase: due?.duePhrase ?? null,
                quote: evidence.quote,
                evidenceStartMs: evidence.evidenceStartMs,
                evidenceSegmentIndex: evidence.evidenceSegmentIndex,
                evidenceCharStart: evidence.evidenceCharStart,
                evidenceCharEnd: evidence.evidenceCharEnd,
                evidenceProvenance: evidence.evidenceProvenance,
                ticked: true,
                source: first.source,
                version: first.version + 1,
                updatedAt: new Date(),
                updatedByUserId: viewer.userId,
            })
            .where(eq(recordingTasks.id, first.id));
        await tx
            .update(taskMentions)
            .set({
                quote: evidence.quote,
                evidenceStartMs: evidence.evidenceStartMs,
                evidenceSegmentIndex: evidence.evidenceSegmentIndex,
                evidenceCharStart: evidence.evidenceCharStart,
                evidenceCharEnd: evidence.evidenceCharEnd,
                provenance: evidence.evidenceProvenance,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(taskMentions.taskId, first.id),
                    eq(taskMentions.itemId, recordingId),
                    eq(taskMentions.matchDecision, "home"),
                ),
            );
        await rejectInTx(
            tx,
            { recordingId, ownerUserId: recording.ownerUserId },
            texts,
        );
        await tx.delete(recordingTasks).where(
            inArray(
                recordingTasks.id,
                rest.map((row) => row?.id ?? ""),
            ),
        );
        return first.id;
    });
    return requireTaskView(viewer, keepId);
}

/** Tick or untick a field proposal or suggested match in the item review. */
export async function tickUpdateProposal(
    viewer: TaskViewer,
    recordingId: string,
    updateId: string,
    ticked: boolean,
    version: number,
): Promise<void> {
    await db.transaction(async (tx) => {
        const recording = await lockRecordingForEdit(tx, viewer, recordingId);
        const updated = await tx
            .update(taskUpdateProposals)
            .set({ ticked, updatedAt: new Date() })
            .where(
                and(
                    eq(taskUpdateProposals.id, updateId),
                    eq(taskUpdateProposals.itemId, recordingId),
                    eq(taskUpdateProposals.userId, recording.ownerUserId),
                    eq(taskUpdateProposals.state, "awaiting_source_review"),
                    eq(taskUpdateProposals.version, version),
                ),
            )
            .returning({ id: taskUpdateProposals.id });
        if (updated.length > 0) return;
        const [mention] = await tx
            .select({
                id: taskMentions.id,
                targetVersion: recordingTasks.version,
                targetStatus: recordingTasks.status,
                visible: sql<boolean>`${taskVisible(viewer, {
                    id: matchCandidateHome.id,
                    userId: matchCandidateHome.userId,
                })}`,
            })
            .from(taskMentions)
            .innerJoin(
                recordingTasks,
                eq(recordingTasks.id, taskMentions.taskId),
            )
            .innerJoin(
                matchCandidateHome,
                eq(matchCandidateHome.id, recordingTasks.itemId),
            )
            .where(
                and(
                    eq(taskMentions.id, updateId),
                    eq(taskMentions.itemId, recordingId),
                    eq(taskMentions.userId, recording.ownerUserId),
                    eq(taskMentions.view, recording.shared ? "org" : "private"),
                    eq(taskMentions.matchDecision, "suggested"),
                    isNull(matchCandidateHome.deletedAt),
                ),
            )
            .limit(1);
        if (
            !mention?.visible ||
            mention.targetStatus !== "open" ||
            mention.targetVersion !== version
        ) {
            throw versionConflict();
        }
        const changed = await tx
            .update(taskMentions)
            .set({ ticked, updatedAt: new Date() })
            .where(
                and(
                    eq(taskMentions.id, mention.id),
                    eq(taskMentions.itemId, recordingId),
                    eq(taskMentions.userId, recording.ownerUserId),
                    eq(taskMentions.matchDecision, "suggested"),
                ),
            )
            .returning({ id: taskMentions.id });
        if (changed.length === 0) throw versionConflict();
    });
}

export interface AcceptResult {
    accepted: number;
    rejected: number;
    /** Follow-ups applied, and those skipped (the task moved on, or the viewer may not). */
    updatesApplied: number;
    updatesSkipped: number;
}

/**
 * Finish a recording's review in one transaction: ticked proposals become
 * open tasks, unticked ones are rejected (and remembered), ticked
 * follow-ups apply to their tasks where the viewer may and the task is
 * still open, and every follow-up of the recording goes.
 */
export async function acceptReview(
    viewer: TaskViewer,
    recordingId: string,
    shown?: {
        proposals: readonly string[];
        updates: readonly string[];
        matches?: readonly string[];
    },
): Promise<AcceptResult> {
    const [authorizedSource] = await db
        .select({
            ownerUserId: chatterItems.userId,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                isNull(chatterItems.deletedAt),
                taskVisible(viewer, ANY_TASK_ITEM),
            ),
        )
        .limit(1);
    if (!authorizedSource?.canEdit) throw notFound();
    const result = await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            await lockItemTaskGraphInTx(tx, {
                itemId: recordingId,
                ownerUserId: authorizedSource.ownerUserId,
            });
            const recording = await lockRecordingForEdit(
                tx,
                viewer,
                recordingId,
            );
            const proposals = await tx
                .select({
                    id: recordingTasks.id,
                    text: recordingTasks.text,
                    ticked: recordingTasks.ticked,
                    version: recordingTasks.version,
                    assigneeCheck: recordingTasks.assigneeCheck,
                })
                .from(recordingTasks)
                .where(
                    and(
                        eq(recordingTasks.itemId, recordingId),
                        eq(recordingTasks.status, "proposed"),
                    ),
                );
            const updateRows = await tx
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
                    ticked: taskUpdateProposals.ticked,
                    version: taskUpdateProposals.version,
                    state: taskUpdateProposals.state,
                    obsoleteReason: taskUpdateProposals.obsoleteReason,
                    decidedByUserId: taskUpdateProposals.decidedByUserId,
                    statementAt: taskUpdateProposals.statementAt,
                    reviewable: sql<boolean>`${reviewableTaskTargetCondition(
                        taskUpdateProposals.taskId,
                        viewer.userId,
                        viewer.isOrg,
                    )}`,
                })
                .from(taskUpdateProposals)
                .where(
                    and(
                        eq(taskUpdateProposals.itemId, recordingId),
                        eq(taskUpdateProposals.userId, recording.ownerUserId),
                        or(
                            eq(
                                taskUpdateProposals.state,
                                "awaiting_source_review",
                            ),
                            and(
                                eq(taskUpdateProposals.state, "obsolete"),
                                eq(
                                    taskUpdateProposals.obsoleteReason,
                                    "earlier_statement",
                                ),
                                isNull(taskUpdateProposals.decidedByUserId),
                            ),
                        ),
                    ),
                );
            const now = new Date();
            const invisibleUpdateIds = updateRows
                .filter(
                    (row) =>
                        row.state === "awaiting_source_review" &&
                        !row.reviewable,
                )
                .map((row) => row.id);
            if (invisibleUpdateIds.length > 0) {
                await tx
                    .update(taskUpdateProposals)
                    .set({
                        state: "obsolete",
                        obsoleteReason: "task_invisible",
                        routedTo: null,
                        decidedByUserId: null,
                        decidedAt: now,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            inArray(taskUpdateProposals.id, invisibleUpdateIds),
                            eq(taskUpdateProposals.itemId, recordingId),
                            eq(
                                taskUpdateProposals.userId,
                                recording.ownerUserId,
                            ),
                            eq(
                                taskUpdateProposals.state,
                                "awaiting_source_review",
                            ),
                        ),
                    );
            }
            const systemUpdateIds = new Set(
                updateRows
                    .filter(
                        (row) =>
                            row.state === "obsolete" &&
                            row.obsoleteReason === "earlier_statement" &&
                            row.decidedByUserId === null,
                    )
                    .map((row) => row.id),
            );
            const updates = updateRows.filter(
                (row) =>
                    row.state === "awaiting_source_review" && row.reviewable,
            );
            const invisibleUpdateIdSet = new Set(invisibleUpdateIds);
            const suggestedMatchRows = await tx
                .select({
                    id: taskMentions.id,
                    taskId: taskMentions.taskId,
                    statementAt: taskMentions.statementAt,
                    ticked: taskMentions.ticked,
                    reviewable: sql<boolean>`${reviewableTaskTargetCondition(
                        taskMentions.taskId,
                        viewer.userId,
                        viewer.isOrg,
                    )}`,
                })
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.itemId, recordingId),
                        eq(taskMentions.userId, recording.ownerUserId),
                        eq(
                            taskMentions.view,
                            recording.shared ? "org" : "private",
                        ),
                        eq(taskMentions.matchDecision, "suggested"),
                    ),
                );
            const invisibleMatchIds = suggestedMatchRows
                .filter((row) => !row.reviewable)
                .map((row) => row.id);
            if (invisibleMatchIds.length > 0) {
                await tx
                    .update(taskMentions)
                    .set({
                        matchDecision: "rejected",
                        decidedByUserId: null,
                        decidedAt: now,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            inArray(taskMentions.id, invisibleMatchIds),
                            eq(taskMentions.itemId, recordingId),
                            eq(taskMentions.userId, recording.ownerUserId),
                            eq(taskMentions.matchDecision, "suggested"),
                        ),
                    );
            }
            const suggestedMatches = suggestedMatchRows.filter(
                (row) => row.reviewable,
            );
            const invisibleMatchIdSet = new Set(invisibleMatchIds);
            // Accept what the reviewer saw: a summary made meanwhile replaced
            // the proposals.
            if (
                shown &&
                (!sameIds(
                    shown.proposals,
                    proposals.map((row) => row.id),
                ) ||
                    !sameIds(
                        shown.updates.filter(
                            (id) =>
                                !systemUpdateIds.has(id) &&
                                !invisibleUpdateIdSet.has(id),
                        ),
                        updates.map((row) => row.id),
                    ) ||
                    (shown.matches !== undefined &&
                        !sameIds(
                            shown.matches.filter(
                                (id) => !invisibleMatchIdSet.has(id),
                            ),
                            suggestedMatches.map((row) => row.id),
                        )))
            ) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The proposals changed meanwhile; review them again",
                    409,
                );
            }
            const selectedStatusKinds = new Map<string, Set<string>>();
            for (const update of updates) {
                if (
                    !update.ticked ||
                    (update.kind !== "done" && update.kind !== "drop")
                ) {
                    continue;
                }
                const kinds =
                    selectedStatusKinds.get(update.taskId) ?? new Set();
                kinds.add(update.kind);
                selectedStatusKinds.set(update.taskId, kinds);
            }
            if (
                [...selectedStatusKinds.values()].some(
                    (kinds) => kinds.has("done") && kinds.has("drop"),
                )
            ) {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Choose either completion or no longer needed for the same task, not both",
                    400,
                );
            }
            const accepted = proposals.filter((row) => row.ticked);
            const rejected = proposals.filter((row) => !row.ticked);
            // Unticked only because the assignee wanted a look, and never looked
            // at: dropped, but not remembered as a "no".
            const unseen = rejected.filter(
                (row) => row.version === 0 && row.assigneeCheck,
            );
            if (accepted.length > 0) {
                const homeMentions = new Map(
                    (
                        await tx
                            .select({
                                taskId: taskMentions.taskId,
                                statementAt: taskMentions.statementAt,
                            })
                            .from(taskMentions)
                            .where(
                                and(
                                    inArray(
                                        taskMentions.taskId,
                                        accepted.map((row) => row.id),
                                    ),
                                    eq(taskMentions.itemId, recordingId),
                                    eq(
                                        taskMentions.userId,
                                        recording.ownerUserId,
                                    ),
                                    eq(taskMentions.matchDecision, "home"),
                                ),
                            )
                    ).map((row) => [row.taskId, row.statementAt] as const),
                );
                for (const proposal of accepted) {
                    const effectiveAt =
                        homeMentions.get(proposal.id) ?? recording.occurredAt;
                    await tx
                        .update(recordingTasks)
                        .set({
                            status: "open",
                            acceptedAt: now,
                            assignedAt: sql`case when ${recordingTasks.assigneePersonId} is null then null else ${now.toISOString()}::timestamp end`,
                            acceptedByUserId: viewer.userId,
                            statusEffectiveAt: effectiveAt,
                            dueEffectiveAt: effectiveAt,
                            assigneeEffectiveAt: effectiveAt,
                            updatedAt: now,
                            updatedByUserId: viewer.userId,
                            version: sql`${recordingTasks.version} + 1`,
                        })
                        .where(eq(recordingTasks.id, proposal.id));
                }
            }
            if (rejected.length > 0) {
                await rejectInTx(
                    tx,
                    { recordingId, ownerUserId: recording.ownerUserId },
                    rejected
                        .filter((row) => !unseen.includes(row))
                        .map((row) => decryptText(row.text)),
                );
                await tx.delete(recordingTasks).where(
                    inArray(
                        recordingTasks.id,
                        rejected.map((row) => row.id),
                    ),
                );
            }

            let updatesApplied = 0;
            let updatesSkipped =
                invisibleUpdateIds.length + invisibleMatchIds.length;
            let touched = new Map<string, string>();
            const selectedMatchTaskIds = new Set<string>();
            const mayAcceptMatches =
                recording.ownerUserId === viewer.userId || viewer.isCurator;
            for (const match of suggestedMatches.filter((row) => row.ticked)) {
                const [target] = await tx
                    .select({
                        status: recordingTasks.status,
                        visible: sql<boolean>`${taskVisible(
                            viewer,
                            ANY_TASK_ITEM,
                        )}`,
                    })
                    .from(recordingTasks)
                    .innerJoin(
                        chatterItems,
                        eq(chatterItems.id, recordingTasks.itemId),
                    )
                    .where(
                        and(
                            eq(recordingTasks.id, match.taskId),
                            isNull(chatterItems.deletedAt),
                        ),
                    )
                    .limit(1);
                if (
                    mayAcceptMatches &&
                    target?.status === "open" &&
                    target.visible
                ) {
                    selectedMatchTaskIds.add(match.taskId);
                } else {
                    updatesSkipped += 1;
                }
            }
            const updateResult = await settleSourceTaskUpdatesInTx(tx, {
                viewer,
                sourceItemId: recordingId,
                sourceOwnerUserId: recording.ownerUserId,
                sourceShared: recording.shared,
                updates,
            });
            updatesApplied = updateResult.applied;
            updatesSkipped += updateResult.skipped;
            touched = updateResult.touched;
            const acceptedMentionIds = suggestedMatches
                .filter(
                    (mention) =>
                        selectedMatchTaskIds.has(mention.taskId) ||
                        updateResult.acceptedTaskIds.has(mention.taskId),
                )
                .map((mention) => mention.id);
            if (acceptedMentionIds.length > 0) {
                await tx
                    .update(taskMentions)
                    .set({
                        matchDecision: "accepted",
                        decidedByUserId: viewer.userId,
                        decidedAt: now,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            inArray(taskMentions.id, acceptedMentionIds),
                            eq(taskMentions.itemId, recordingId),
                            eq(taskMentions.userId, recording.ownerUserId),
                            eq(
                                taskMentions.view,
                                recording.shared ? "org" : "private",
                            ),
                            eq(taskMentions.matchDecision, "suggested"),
                        ),
                    );
            }
            const acceptedMentionIdSet = new Set(acceptedMentionIds);
            const rejectedMentionIds = suggestedMatches
                .filter((mention) => !acceptedMentionIdSet.has(mention.id))
                .map((mention) => mention.id);
            if (rejectedMentionIds.length > 0) {
                await tx
                    .update(taskMentions)
                    .set({
                        matchDecision: "rejected",
                        decidedByUserId: viewer.userId,
                        decidedAt: now,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            inArray(taskMentions.id, rejectedMentionIds),
                            eq(taskMentions.itemId, recordingId),
                            eq(taskMentions.userId, recording.ownerUserId),
                            eq(
                                taskMentions.view,
                                recording.shared ? "org" : "private",
                            ),
                            eq(taskMentions.matchDecision, "suggested"),
                        ),
                    );
            }
            await requestAdvanceInTx(tx, {
                itemId: recordingId,
                userId: recording.ownerUserId,
                view: recording.shared ? "org" : "private",
                reason: "task-review",
            });
            return {
                accepted: accepted.length,
                rejected: rejected.length,
                updatesApplied,
                updatesSkipped,
                touched,
                ownerUserId: recording.ownerUserId,
            };
        }),
    );
    nudge();
    await tasksChanged(result.ownerUserId, recordingId);
    for (const [other, owner] of result.touched) {
        await tasksChanged(owner, other);
    }
    return {
        accepted: result.accepted,
        rejected: result.rejected,
        updatesApplied: result.updatesApplied,
        updatesSkipped: result.updatesSkipped,
    };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
    const set = new Set(a);
    return set.size === b.length && b.every((id) => set.has(id));
}

async function requireTaskView(
    viewer: TaskViewer,
    taskId: string,
): Promise<TaskView> {
    const [row] = await db
        .select({
            ...taskColumns,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
            canClose: sql<boolean>`${taskClosable(viewer, ANY_TASK_ITEM)}`,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .leftJoin(people, assigneeJoin())
        .where(
            and(
                eq(recordingTasks.id, taskId),
                taskVisible(viewer, ANY_TASK_ITEM),
            ),
        )
        .limit(1);
    if (!row) throw notFound();
    const mentions = await loadVisibleTaskMentions(viewer, [taskId]);
    return toView(row, mentions);
}

/**
 * Recordings with proposals or follow-ups waiting for the viewer's review,
 * newest first, with how many.
 */
export async function recordingsAwaitingTaskReview(viewer: TaskViewer): Promise<
    {
        recordingId: string;
        kind: "audio" | "mail";
        title: string;
        proposals: number;
    }[]
> {
    const [proposals, followUps, matches] = await Promise.all([
        db
            .select({
                recordingId: recordingTasks.itemId,
                taskId: recordingTasks.id,
            })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.status, "proposed"),
                    taskEditable(viewer, {
                        id: recordingTasks.itemId,
                        userId: recordingTasks.userId,
                    }),
                ),
            ),
        db
            .select({
                recordingId: taskUpdateProposals.itemId,
                taskId: taskUpdateProposals.taskId,
            })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.state, "awaiting_source_review"),
                    taskEditable(viewer, {
                        id: taskUpdateProposals.itemId,
                        userId: taskUpdateProposals.userId,
                    }),
                    reviewableTaskTargetCondition(
                        taskUpdateProposals.taskId,
                        viewer.userId,
                        viewer.isOrg,
                    ),
                ),
            ),
        db
            .select({
                recordingId: taskMentions.itemId,
                taskId: taskMentions.taskId,
            })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.matchDecision, "suggested"),
                    taskEditable(viewer, {
                        id: taskMentions.itemId,
                        userId: taskMentions.userId,
                    }),
                    reviewableTaskTargetCondition(
                        taskMentions.taskId,
                        viewer.userId,
                        viewer.isOrg,
                    ),
                    notExists(
                        db
                            .select({ id: taskUpdateProposals.id })
                            .from(taskUpdateProposals)
                            .where(
                                and(
                                    eq(
                                        taskUpdateProposals.itemId,
                                        taskMentions.itemId,
                                    ),
                                    eq(
                                        taskUpdateProposals.userId,
                                        taskMentions.userId,
                                    ),
                                    eq(
                                        taskUpdateProposals.taskId,
                                        taskMentions.taskId,
                                    ),
                                    eq(taskUpdateProposals.state, "obsolete"),
                                    eq(
                                        taskUpdateProposals.obsoleteReason,
                                        "earlier_statement",
                                    ),
                                    isNull(taskUpdateProposals.decidedByUserId),
                                ),
                            ),
                    ),
                ),
            ),
    ]);
    const waiting = new Map<string, Set<string>>();
    for (const proposal of proposals) {
        const decisions =
            waiting.get(proposal.recordingId) ?? new Set<string>();
        decisions.add(`new:${proposal.taskId}`);
        waiting.set(proposal.recordingId, decisions);
    }
    for (const proposal of [...followUps, ...matches]) {
        const decisions =
            waiting.get(proposal.recordingId) ?? new Set<string>();
        decisions.add(`existing:${proposal.taskId}`);
        waiting.set(proposal.recordingId, decisions);
    }
    if (waiting.size === 0) return [];
    const rows = await db
        .select({
            recordingId: chatterItems.id,
            kind: chatterItems.kind,
            title: chatterItems.title,
        })
        .from(chatterItems)
        .where(
            and(
                inArray(chatterItems.id, [...waiting.keys()]),
                isNull(chatterItems.deletedAt),
                taskEditable(viewer, {
                    id: chatterItems.id,
                    userId: chatterItems.userId,
                }),
            ),
        )
        .orderBy(desc(chatterItems.occurredAt));
    return rows.map((row) => ({
        recordingId: row.recordingId,
        kind: row.kind,
        title: decryptText(row.title),
        proposals: waiting.get(row.recordingId)?.size ?? 0,
    }));
}

export type TaskTab = "mine" | "tracked";
export type TaskStateFilter = "open" | "done" | "dropped" | "all";
export type TaskDueFilter = "overdue" | "week" | "none" | null;
export type TaskSort = "created" | "due";

export interface TaskListQuery {
    tab: TaskTab;
    state: TaskStateFilter;
    folderId: string | null;
    due: TaskDueFilter;
    /** The viewer's today, `YYYY-MM-DD`, for the due filters. */
    today: string | null;
    sort: TaskSort;
}

export interface TaskListItem extends TaskView {
    /** Visible mention quotes used by MCP's encrypted-text scan. */
    visibleMentionQuotes: { text: string; kind: "audio" | "mail" }[];
    recording: {
        id: string;
        title: string;
        startTime: string;
        /** The view the viewer opens it in. */
        view: "private" | "org";
        /** What the item is: a recording or a mail. */
        kind: "audio" | "mail";
    };
}

function addDays(day: string, days: number): string {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/**
 * The viewer's task list. Mine: assigned to them, on their recordings or
 * shared ones. Tracked: everything else on recordings they answer for
 * (their own; for the organization account, the shared ones).
 */
export async function listTasks(
    viewer: TaskViewer,
    query: TaskListQuery,
): Promise<TaskListItem[]> {
    const conditions: (SQL | undefined)[] = [
        ne(recordingTasks.status, "proposed"),
        isNull(chatterItems.deletedAt),
    ];
    const mine = assignedToViewer(viewer);
    if (query.tab === "mine") {
        if (viewer.isOrg) return [];
        conditions.push(mine, taskVisible(viewer, ANY_TASK_ITEM));
    } else {
        conditions.push(taskListed(viewer, ANY_TASK_ITEM), not(mine));
    }
    if (query.state !== "all") {
        conditions.push(eq(recordingTasks.status, query.state));
    }
    if (query.folderId) {
        conditions.push(
            await folderCondition(viewer.userId, query.folderId, ANY_TASK_ITEM),
        );
    }
    if (query.due === "none") {
        conditions.push(isNull(recordingTasks.dueDate));
    } else if (query.due && query.today) {
        conditions.push(
            query.due === "overdue"
                ? lt(recordingTasks.dueDate, query.today)
                : and(
                      gte(recordingTasks.dueDate, query.today),
                      lte(recordingTasks.dueDate, addDays(query.today, 7)),
                  ),
        );
    }

    return loadTaskListItems(
        viewer,
        conditions,
        [
            ...(query.sort === "due"
                ? [
                      sql`${recordingTasks.dueDate} asc nulls last`,
                      desc(recordingTasks.createdAt),
                  ]
                : [desc(recordingTasks.createdAt)]),
            asc(recordingTasks.id),
        ],
        LIST_LIMIT,
    );
}

/** A query of {@link listCallerTasks}. */
export interface CallerTaskQuery {
    status: TaskStateFilter;
    assigneePersonId: string | null;
    recordingId: string | null;
    /** `YYYY-MM-DD`: due strictly before this day; undated tasks drop out. */
    dueBefore: string | null;
    /**
     * SQL over `recordings` the task's recording must also pass: a task on
     * a mail then drops out.
     */
    recordingCondition: SQL | null;
    /** Continue after this position of the newest-first order. */
    after: Keyset | null;
    limit: number;
}

// A task on a mail is listed like one on a recording (D8: tasks learned
// from mail stay visible under their own role; callers redact the mail).
function callerTaskConditions(viewer: TaskViewer): SQL[] {
    return [
        ne(recordingTasks.status, "proposed"),
        isNull(chatterItems.deletedAt),
        taskListed(viewer, ANY_TASK_ITEM),
    ];
}

/**
 * Every task in the viewer's lists (the Tasks page's tabs together; never
 * a proposal, never on a deleted recording or mail) that passes the query,
 * newest first (`createdAt`, then `id`), `limit` at most after `after`.
 */
export async function listCallerTasks(
    viewer: TaskViewer,
    query: CallerTaskQuery,
): Promise<TaskListItem[]> {
    const conditions = callerTaskConditions(viewer);
    if (query.status !== "all") {
        conditions.push(eq(recordingTasks.status, query.status));
    }
    if (query.assigneePersonId) {
        conditions.push(
            eq(recordingTasks.assigneePersonId, query.assigneePersonId),
        );
    }
    if (query.recordingId) {
        conditions.push(eq(recordingTasks.itemId, query.recordingId));
    }
    if (query.dueBefore) {
        conditions.push(lt(recordingTasks.dueDate, query.dueBefore));
    }
    if (query.recordingCondition) conditions.push(query.recordingCondition);
    if (query.after) {
        conditions.push(
            keysetBefore(
                recordingTasks.createdAt,
                recordingTasks.id,
                query.after,
            ),
        );
    }
    return loadTaskListItems(
        viewer,
        conditions,
        keysetOrder(recordingTasks.createdAt, recordingTasks.id),
        query.limit,
    );
}

/** One task of the viewer's lists (see {@link listCallerTasks}), or null. */
export async function getCallerTask(
    viewer: TaskViewer,
    taskId: string,
): Promise<TaskListItem | null> {
    const [item] = await loadTaskListItems(
        viewer,
        [...callerTaskConditions(viewer), eq(recordingTasks.id, taskId)],
        [],
        1,
    );
    return item ?? null;
}

async function loadTaskListItems(
    viewer: TaskViewer,
    conditions: readonly (SQL | undefined)[],
    order: readonly SQL[],
    limit: number,
): Promise<TaskListItem[]> {
    const rows = await db
        .select({
            ...taskColumns,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM)}`,
            canClose: sql<boolean>`${taskClosable(viewer, ANY_TASK_ITEM)}`,
            recordingOwner: chatterItems.userId,
            recordingTitle: chatterItems.title,
            recordingStart: chatterItems.occurredAt,
            recordingKind: chatterItems.kind,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        // Conditions over `recordings` (the MCP tools') keep to recordings.
        .leftJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .leftJoin(people, assigneeJoin())
        .where(and(...conditions))
        .orderBy(...order)
        .limit(limit);

    const mentions = await loadVisibleTaskMentions(
        viewer,
        rows.map((row) => row.id),
    );
    return rows.map((row) => ({
        ...toView(row, mentions),
        visibleMentionQuotes:
            mentions.quotes.get(row.id) ??
            (mentions.taskIdsWithMentions.has(row.id)
                ? []
                : [decryptOptional(row.quote)]
                      .filter((quote): quote is string => quote !== null)
                      .map((text) => ({ text, kind: row.recordingKind }))),
        recording: {
            id: row.recordingId as string,
            title: decryptText(row.recordingTitle),
            startTime: row.recordingStart.toISOString(),
            view: row.recordingOwner === viewer.userId ? "private" : "org",
            kind: row.recordingKind,
        },
    }));
}

/** Open tasks assigned to the viewer since they last opened the list. */
export async function countNewTasks(viewer: TaskViewer): Promise<number> {
    const [settings] = await db
        .select({ seen: userSettings.tasksSeenAt })
        .from(userSettings)
        .where(eq(userSettings.userId, viewer.userId))
        .limit(1);
    const [assigned, routed] = await Promise.all([
        viewer.isOrg
            ? Promise.resolve(0)
            : db
                  .select({ count: sql<number>`count(*)::int` })
                  .from(recordingTasks)
                  .innerJoin(
                      chatterItems,
                      eq(chatterItems.id, recordingTasks.itemId),
                  )
                  .where(
                      and(
                          eq(recordingTasks.status, "open"),
                          isNull(chatterItems.deletedAt),
                          assignedToViewer(viewer),
                          taskVisible(viewer, ANY_TASK_ITEM),
                          // Their own recording's tasks are not news to them.
                          ne(chatterItems.userId, viewer.userId),
                          settings?.seen
                              ? gt(recordingTasks.assignedAt, settings.seen)
                              : undefined,
                      ),
                  )
                  .then(([row]) => row?.count ?? 0),
        countRoutedTaskProposals(viewer),
    ]);
    return assigned + routed;
}

/** The viewer opened their task list: the badge starts again from now. */
export async function markTasksSeen(viewer: TaskViewer): Promise<void> {
    const now = new Date();
    // Not everyone has saved settings yet.
    await db
        .insert(userSettings)
        .values({ userId: viewer.userId, tasksSeenAt: now })
        .onConflictDoUpdate({
            target: userSettings.userId,
            set: { tasksSeenAt: now },
        });
}
