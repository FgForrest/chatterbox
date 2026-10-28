import { and, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
    chatterItems,
    type EvidenceProvenance,
    people,
    recordingTasks,
    type TaskUpdateProposalKind,
    taskFollowers,
    taskHomeMoves,
    taskMentions,
    taskStatusTransitions,
    taskUnfollows,
    taskUpdateProposals,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    type ArchiveScope,
    archivedItemCondition,
} from "@/lib/export/archive-scope";
import {
    archivedTaskMentionVisible,
    loadArchivedTaskMentions,
} from "@/lib/tasks/mentions";

/** One task as a backup archive carries it. */
export interface ArchivedTask {
    id: string;
    status: "proposed" | "open" | "done" | "dropped";
    text: string;
    note?: string | null;
    noteUpdatedAt?: string | null;
    noteUpdatedByUserId?: string | null;
    version?: number;
    folderId?: string | null;
    assignee: { personId: string; name: string } | null;
    assigneeHint: string | null;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    /** On a mail: the segment and range of its text the quote is in. */
    evidenceText?: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    };
    evidenceProvenance?: EvidenceProvenance;
    source: string;
    createdAt: string;
    acceptedAt: string | null;
    statusChangedAt: string | null;
    statusTransitions?: {
        id: string;
        actorUserId: string | null;
        fromStatus: ArchivedTask["status"] | null;
        toStatus: ArchivedTask["status"];
        createdAt: string;
    }[];
    /** A proposal's draft, or an accepted task's unresolved assignee. */
    review?: { ticked: boolean; assigneeCheck: boolean };
}

/** A proposed or settled change to an earlier task heard on an item. */
export interface ArchivedTaskUpdate {
    id: string;
    /** The task it changes: in the same archive. */
    taskId: string;
    itemId: string;
    kind: TaskUpdateProposalKind;
    dueDate: string | null;
    duePhrase: string | null;
    proposedAssignee: { personId: string; name: string } | null;
    proposedAssigneeHint: string | null;
    proposedAssigneeCheck: boolean;
    quote: string | null;
    evidenceStartMs: number | null;
    /** As on a task of a mail. */
    evidenceText?: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    };
    evidenceProvenance?: EvidenceProvenance;
    statementAt: string;
    state:
        | "awaiting_source_review"
        | "awaiting_share"
        | "awaiting_target_review"
        | "applied"
        | "rejected"
        | "obsolete";
    routedTo: string[] | { role: "curators" } | null;
    decidedByUserId: string | null;
    decidedAt: string | null;
    obsoleteReason: string | null;
    ticked: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
}

/** A task mention with contained evidence, or a redacted external reference. */
export type ArchivedTaskMention =
    | {
          taskId: string;
          itemId: string;
          external: true;
          taskExternal: boolean;
          statementAt: string;
          matchDecision:
              | "home"
              | "suggested"
              | "accepted"
              | "rejected"
              | "undone"
              | "kept_new";
          decidedAt: string | null;
          createdAt: string;
          updatedAt: string;
      }
    | {
          id: string;
          taskId: string;
          itemId: string;
          userId: string;
          view: "private" | "org";
          external: false;
          taskExternal: boolean;
          evidenceStartMs: number | null;
          evidenceText?: {
              segmentIndex: number;
              charStart: number;
              charEnd: number;
          };
          quote: string | null;
          provenance: EvidenceProvenance | null;
          contentSourceId: string | null;
          contentRevision: number | null;
          statementAt: string;
          matchDecision:
              | "home"
              | "suggested"
              | "accepted"
              | "rejected"
              | "undone"
              | "kept_new";
          ticked: boolean;
          decidedByUserId: string | null;
          decidedAt: string | null;
          createdAt: string;
          updatedAt: string;
      };

/** One audited change of an archived task's home item. */
export interface ArchivedTaskHomeMove {
    id: string;
    taskId: string;
    fromItemId: string | null;
    fromItemExternal: boolean;
    toItemId: string | null;
    toItemExternal: boolean;
    fromUserId: string | null;
    toUserId: string | null;
    reason: "deleted" | "erased" | "withdrawn";
    actorUserId: string | null;
    createdAt: string;
}

function optional(value: string | null): string | null {
    return value ? decryptText(value) : null;
}

/**
 * Whose tasks an archive or a Markdown document carries: a backup's scope,
 * or every task of the owner's recordings (`owner`, the documents rendered
 * from the owner's rows).
 */
export type TaskArchiveScope = ArchiveScope | { kind: "owner"; userId: string };

/** Task ownership within an archive, excluding Organization-authored manual tasks from personal archives. */
export function archivedTaskCondition(
    scope: TaskArchiveScope,
): SQL | undefined {
    if (scope.kind === "organization") {
        return archivedItemCondition(scope);
    }
    if (scope.kind === "owner") return eq(recordingTasks.userId, scope.userId);
    return and(
        eq(recordingTasks.userId, scope.userId),
        or(
            ne(recordingTasks.source, "manual"),
            eq(recordingTasks.createdByUserId, scope.userId),
        ),
    );
}

/**
 * The tasks of `recordingIds` a scope carries, by recording, for backup
 * archives and exports. Proposals waiting for review come along only with
 * `proposals` (a backup); a document lists accepted tasks.
 */
export async function tasksForArchive(
    scope: TaskArchiveScope,
    recordingIds: readonly string[],
    {
        proposals = false,
        personal = false,
    }: { proposals?: boolean; personal?: boolean } = {},
): Promise<Map<string, ArchivedTask[]>> {
    const byRecording = new Map<string, ArchivedTask[]>();
    if (recordingIds.length === 0 && !personal) return byRecording;
    const rows = await db
        .select({
            id: recordingTasks.id,
            recordingId: recordingTasks.itemId,
            folderId: recordingTasks.folderId,
            status: recordingTasks.status,
            text: recordingTasks.text,
            note: recordingTasks.note,
            noteUpdatedAt: recordingTasks.noteUpdatedAt,
            noteUpdatedByUserId: recordingTasks.noteUpdatedByUserId,
            version: recordingTasks.version,
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
            source: recordingTasks.source,
            ticked: recordingTasks.ticked,
            createdAt: recordingTasks.createdAt,
            acceptedAt: recordingTasks.acceptedAt,
            statusChangedAt: recordingTasks.statusChangedAt,
        })
        .from(recordingTasks)
        .leftJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingTasks.itemId),
                eq(chatterItems.userId, recordingTasks.userId),
            ),
        )
        .leftJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                archivedTaskCondition(scope),
                personal
                    ? isNull(recordingTasks.itemId)
                    : inArray(recordingTasks.itemId, [...recordingIds]),
                proposals ? undefined : ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(recordingTasks.position, recordingTasks.createdAt);
    const transitions =
        proposals && rows.length
            ? await db
                  .select({
                      taskId: taskStatusTransitions.taskId,
                      id: taskStatusTransitions.id,
                      actorUserId: taskStatusTransitions.actorUserId,
                      fromStatus: taskStatusTransitions.fromStatus,
                      toStatus: taskStatusTransitions.toStatus,
                      createdAt: taskStatusTransitions.createdAt,
                  })
                  .from(taskStatusTransitions)
                  .innerJoin(
                      recordingTasks,
                      eq(recordingTasks.id, taskStatusTransitions.taskId),
                  )
                  .leftJoin(
                      chatterItems,
                      eq(chatterItems.id, recordingTasks.itemId),
                  )
                  .where(
                      and(
                          archivedTaskCondition(scope),
                          inArray(
                              recordingTasks.id,
                              rows.map((row) => row.id),
                          ),
                      ),
                  )
                  .orderBy(
                      taskStatusTransitions.createdAt,
                      taskStatusTransitions.id,
                  )
            : [];
    const history = new Map<
        string,
        NonNullable<ArchivedTask["statusTransitions"]>
    >();
    for (const { taskId, createdAt, ...transition } of transitions) {
        const entries = history.get(taskId) ?? [];
        entries.push({ ...transition, createdAt: createdAt.toISOString() });
        history.set(taskId, entries);
    }
    const mentions = await loadArchivedTaskMentions(
        scope,
        rows.map((row) => row.id),
    );
    for (const row of rows) {
        const mention = mentions.latest.get(row.id);
        const legacy = !mentions.taskIdsWithMentions.has(row.id);
        const segmentIndex =
            mention?.evidenceSegmentIndex ??
            (legacy ? row.evidenceSegmentIndex : null);
        const charStart =
            mention?.evidenceCharStart ??
            (legacy ? row.evidenceCharStart : null);
        const charEnd =
            mention?.evidenceCharEnd ?? (legacy ? row.evidenceCharEnd : null);
        const provenance =
            mention?.provenance ?? (legacy ? row.evidenceProvenance : null);
        const list = byRecording.get(row.recordingId ?? "") ?? [];
        const status = row.status as ArchivedTask["status"];
        list.push({
            id: row.id,
            status,
            text: decryptText(row.text),
            note: optional(row.note),
            noteUpdatedAt: row.noteUpdatedAt?.toISOString() ?? null,
            noteUpdatedByUserId: row.noteUpdatedByUserId,
            version: row.version,
            ...(row.source === "personal" ? { folderId: row.folderId } : {}),
            assignee:
                row.assigneePersonId && row.assigneeName
                    ? {
                          personId: row.assigneePersonId,
                          name: decryptText(row.assigneeName),
                      }
                    : null,
            assigneeHint: optional(row.assigneeHint),
            dueDate: row.dueDate,
            duePhrase: optional(row.duePhrase),
            quote: mention?.quote ?? (legacy ? optional(row.quote) : null),
            evidenceStartMs:
                mention?.evidenceStartMs ??
                (legacy ? row.evidenceStartMs : null),
            ...(segmentIndex !== null && charStart !== null && charEnd !== null
                ? {
                      evidenceText: {
                          segmentIndex,
                          charStart,
                          charEnd,
                      },
                  }
                : {}),
            ...(provenance ? { evidenceProvenance: provenance } : {}),
            source: row.source,
            createdAt: row.createdAt.toISOString(),
            acceptedAt: row.acceptedAt?.toISOString() ?? null,
            statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
            ...(proposals
                ? { statusTransitions: history.get(row.id) ?? [] }
                : {}),
            ...(status === "proposed" || row.assigneeCheck
                ? {
                      review: {
                          ticked: row.ticked,
                          assigneeCheck: row.assigneeCheck,
                      },
                  }
                : {}),
        });
        byRecording.set(row.recordingId ?? "", list);
    }
    return byRecording;
}

/**
 * The follow-ups heard on `recordingIds` and waiting for review, by the
 * recording they were heard on: only those whose task the same archive
 * carries (`archivedTaskIds`), so none points at someone else's task.
 */
export async function taskUpdatesForArchive(
    scope: ArchiveScope,
    recordingIds: readonly string[],
    archivedTaskIds: ReadonlySet<string>,
): Promise<Map<string, ArchivedTaskUpdate[]>> {
    const byRecording = new Map<string, ArchivedTaskUpdate[]>();
    if (recordingIds.length === 0 || archivedTaskIds.size === 0) {
        return byRecording;
    }
    const proposedAssignee = alias(people, "archived_proposed_assignee");
    const rows = await db
        .select({
            id: taskUpdateProposals.id,
            recordingId: taskUpdateProposals.itemId,
            itemId: taskUpdateProposals.itemId,
            taskId: taskUpdateProposals.taskId,
            kind: taskUpdateProposals.kind,
            dueDate: taskUpdateProposals.dueDate,
            duePhrase: taskUpdateProposals.duePhrase,
            proposedAssigneePersonId:
                taskUpdateProposals.proposedAssigneePersonId,
            proposedAssigneeName: proposedAssignee.displayName,
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
            routedTo: taskUpdateProposals.routedTo,
            decidedByUserId: taskUpdateProposals.decidedByUserId,
            decidedAt: taskUpdateProposals.decidedAt,
            obsoleteReason: taskUpdateProposals.obsoleteReason,
            ticked: taskUpdateProposals.ticked,
            version: taskUpdateProposals.version,
            createdAt: taskUpdateProposals.createdAt,
            updatedAt: taskUpdateProposals.updatedAt,
        })
        .from(taskUpdateProposals)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, taskUpdateProposals.itemId),
                eq(chatterItems.userId, taskUpdateProposals.userId),
            ),
        )
        .leftJoin(
            proposedAssignee,
            eq(
                proposedAssignee.id,
                taskUpdateProposals.proposedAssigneePersonId,
            ),
        )
        .where(
            and(
                scope.kind === "personal"
                    ? eq(taskUpdateProposals.userId, scope.userId)
                    : archivedItemCondition(scope),
                inArray(taskUpdateProposals.itemId, [...recordingIds]),
            ),
        )
        .orderBy(taskUpdateProposals.createdAt);
    for (const row of rows) {
        if (!archivedTaskIds.has(row.taskId)) continue;
        const list = byRecording.get(row.recordingId) ?? [];
        list.push({
            id: row.id,
            taskId: row.taskId,
            itemId: row.itemId,
            kind: row.kind,
            dueDate: row.dueDate,
            duePhrase: optional(row.duePhrase),
            proposedAssignee:
                row.proposedAssigneePersonId && row.proposedAssigneeName
                    ? {
                          personId: row.proposedAssigneePersonId,
                          name: decryptText(row.proposedAssigneeName),
                      }
                    : null,
            proposedAssigneeHint: optional(row.proposedAssigneeHint),
            proposedAssigneeCheck: row.proposedAssigneeCheck,
            quote: optional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
            ...(row.evidenceSegmentIndex !== null &&
            row.evidenceCharStart !== null &&
            row.evidenceCharEnd !== null
                ? {
                      evidenceText: {
                          segmentIndex: row.evidenceSegmentIndex,
                          charStart: row.evidenceCharStart,
                          charEnd: row.evidenceCharEnd,
                      },
                  }
                : {}),
            ...(row.evidenceProvenance
                ? { evidenceProvenance: row.evidenceProvenance }
                : {}),
            statementAt: row.statementAt.toISOString(),
            state: row.state,
            routedTo: row.routedTo ?? null,
            decidedByUserId: row.decidedByUserId,
            decidedAt: row.decidedAt?.toISOString() ?? null,
            obsoleteReason: row.obsoleteReason,
            ticked: row.ticked,
            version: row.version,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        });
        byRecording.set(row.recordingId, list);
    }
    return byRecording;
}

/** Every decision about an archived task, with evidence only for contained items. */
export async function taskMentionsForArchive(
    scope: ArchiveScope,
    archivedTaskIds: ReadonlySet<string>,
    containedItemIds: ReadonlySet<string>,
): Promise<ArchivedTaskMention[]> {
    if (
        archivedTaskIds.size === 0 &&
        (scope.kind !== "personal" || containedItemIds.size === 0)
    ) {
        return [];
    }
    const rows = await db
        .select({
            id: taskMentions.id,
            taskId: taskMentions.taskId,
            itemId: taskMentions.itemId,
            userId: taskMentions.userId,
            view: taskMentions.view,
            evidenceStartMs: taskMentions.evidenceStartMs,
            evidenceSegmentIndex: taskMentions.evidenceSegmentIndex,
            evidenceCharStart: taskMentions.evidenceCharStart,
            evidenceCharEnd: taskMentions.evidenceCharEnd,
            quote: taskMentions.quote,
            provenance: taskMentions.provenance,
            contentSourceId: taskMentions.contentSourceId,
            contentRevision: taskMentions.contentRevision,
            statementAt: taskMentions.statementAt,
            matchDecision: taskMentions.matchDecision,
            ticked: taskMentions.ticked,
            decidedByUserId: taskMentions.decidedByUserId,
            decidedAt: taskMentions.decidedAt,
            createdAt: taskMentions.createdAt,
            updatedAt: taskMentions.updatedAt,
        })
        .from(taskMentions)
        .innerJoin(recordingTasks, eq(recordingTasks.id, taskMentions.taskId))
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, taskMentions.itemId),
                eq(chatterItems.userId, taskMentions.userId),
            ),
        )
        .where(
            and(
                scope.kind === "personal"
                    ? or(
                          archivedTaskIds.size > 0
                              ? and(
                                    eq(recordingTasks.userId, scope.userId),
                                    inArray(taskMentions.taskId, [
                                        ...archivedTaskIds,
                                    ]),
                                )
                              : undefined,
                          containedItemIds.size > 0
                              ? and(
                                    eq(taskMentions.userId, scope.userId),
                                    inArray(taskMentions.itemId, [
                                        ...containedItemIds,
                                    ]),
                                )
                              : undefined,
                      )
                    : and(
                          inArray(taskMentions.taskId, [...archivedTaskIds]),
                          archivedTaskMentionVisible(scope),
                      ),
            ),
        )
        .orderBy(
            taskMentions.statementAt,
            taskMentions.createdAt,
            taskMentions.id,
        );

    return rows.map((row) => {
        const dates = {
            statementAt: row.statementAt.toISOString(),
            decidedAt: row.decidedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
        if (!containedItemIds.has(row.itemId)) {
            return {
                taskId: row.taskId,
                itemId: row.itemId,
                external: true as const,
                taskExternal: !archivedTaskIds.has(row.taskId),
                ...dates,
                matchDecision: row.matchDecision,
            };
        }
        return {
            id: row.id,
            taskId: row.taskId,
            itemId: row.itemId,
            userId: row.userId,
            view: row.view,
            external: false as const,
            taskExternal: !archivedTaskIds.has(row.taskId),
            evidenceStartMs: row.evidenceStartMs,
            ...(row.evidenceSegmentIndex !== null &&
            row.evidenceCharStart !== null &&
            row.evidenceCharEnd !== null
                ? {
                      evidenceText: {
                          segmentIndex: row.evidenceSegmentIndex,
                          charStart: row.evidenceCharStart,
                          charEnd: row.evidenceCharEnd,
                      },
                  }
                : {}),
            quote: optional(row.quote),
            provenance: row.provenance,
            contentSourceId: row.contentSourceId,
            contentRevision: row.contentRevision,
            ...dates,
            matchDecision: row.matchDecision,
            ticked: row.ticked,
            decidedByUserId: row.decidedByUserId,
        };
    });
}

/** Home-move history for archived tasks, marking item references outside the archive. */
export async function taskHomeMovesForArchive(
    scope: ArchiveScope,
    archivedTaskIds: ReadonlySet<string>,
    containedItemIds: ReadonlySet<string>,
): Promise<ArchivedTaskHomeMove[]> {
    if (archivedTaskIds.size === 0) return [];
    const rows = await db
        .select({
            id: taskHomeMoves.id,
            taskId: taskHomeMoves.taskId,
            fromItemId: taskHomeMoves.fromItemId,
            toItemId: taskHomeMoves.toItemId,
            fromUserId: taskHomeMoves.fromUserId,
            toUserId: taskHomeMoves.toUserId,
            reason: taskHomeMoves.reason,
            actorUserId: taskHomeMoves.actorUserId,
            createdAt: taskHomeMoves.createdAt,
        })
        .from(taskHomeMoves)
        .innerJoin(recordingTasks, eq(recordingTasks.id, taskHomeMoves.taskId))
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingTasks.itemId),
                eq(chatterItems.userId, recordingTasks.userId),
            ),
        )
        .where(
            and(
                inArray(taskHomeMoves.taskId, [...archivedTaskIds]),
                scope.kind === "personal"
                    ? eq(recordingTasks.userId, scope.userId)
                    : archivedItemCondition(scope),
            ),
        )
        .orderBy(taskHomeMoves.createdAt, taskHomeMoves.id);
    return rows.map((row) => ({
        ...row,
        fromItemExternal:
            row.fromItemId !== null && !containedItemIds.has(row.fromItemId),
        toItemExternal:
            row.toItemId !== null && !containedItemIds.has(row.toItemId),
        createdAt: row.createdAt.toISOString(),
    }));
}

/** The people the archived tasks are assigned to. */
export function archivedAssigneeIds(
    tasks: Iterable<readonly ArchivedTask[]>,
): string[] {
    const ids = new Set<string>();
    for (const list of tasks) {
        for (const task of list) {
            if (task.assignee) ids.add(task.assignee.personId);
        }
    }
    return [...ids];
}

export interface ArchivedTaskFollow {
    taskId: string;
    follow: boolean;
    createdAt: string;
}

/** Own tasks belong only to their author's personal archive. */
export async function personalTasksForArchive(
    scope: ArchiveScope,
): Promise<ArchivedTask[]> {
    if (scope.kind !== "personal") return [];
    return (
        (
            await tasksForArchive(scope, [], {
                personal: true,
                proposals: true,
            })
        ).get("") ?? []
    );
}

/** Follow preferences include temporarily invisible tasks, without their content. */
export async function followsForArchive(
    scope: ArchiveScope,
): Promise<ArchivedTaskFollow[]> {
    if (scope.kind !== "personal") return [];
    const lists = await Promise.all(
        [taskFollowers, taskUnfollows].map((table) =>
            db
                .select({ taskId: table.taskId, createdAt: table.createdAt })
                .from(table)
                .where(eq(table.userId, scope.userId))
                .orderBy(table.taskId),
        ),
    );
    return lists.flatMap((rows, index) =>
        rows.map((row) => ({
            taskId: row.taskId,
            follow: index === 0,
            createdAt: row.createdAt.toISOString(),
        })),
    );
}
