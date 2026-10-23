import { type AnyColumn, and, eq, or, type SQL, sql } from "drizzle-orm";
import {
    chatterItems,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskFollowers,
    taskMentions,
    taskUnfollows,
} from "@/db/schema";

/**
 * Who may do what with a task (maintainer, 2026-10-07):
 *
 * | action                   | private recording | shared recording                          |
 * |--------------------------|-------------------|-------------------------------------------|
 * | edit, add, drop, review  | owner             | home owner, curator                        |
 * | done, reopen             | owner             | home owner, assignee, curator              |
 * | see                      | owner             | everyone; list: owner, assignee, curator   |
 *
 * A task on a private recording reaches nobody but its owner, even when it
 * names someone else: tasks travel only through the Organization. The
 * assignee is a user when their person's email is that user's login email.
 */
export interface TaskViewer {
    userId: string;
    /** `lookupHash` of the viewer's login email. */
    emailHash: string;
    isOrg: boolean;
    /** The viewer currently acts as an Organization curator. */
    isCurator: boolean;
    /** The organization account this instance shows, or null. */
    orgUserId: string | null;
}

/** The id and owner columns of the table a task's item is joined as. */
export interface TaskItemColumns {
    id: AnyColumn;
    userId: AnyColumn;
}

/** `recordings` joined: the tasks of recordings only. */
export const RECORDING_TASK_ITEM: TaskItemColumns = {
    id: recordings.id,
    userId: recordings.userId,
};

/** `chatter_items` joined: the tasks of every kind of item. */
export const ANY_TASK_ITEM: TaskItemColumns = {
    id: chatterItems.id,
    userId: chatterItems.userId,
};

/** SQL: the task's recording (`recordings` joined, or `item`) is shared. */
export function taskRecordingShared(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    if (!viewer.orgUserId) return sql`false`;
    return sql`exists (
        select 1
        from ${recordingFolderAssignments}
        inner join ${recordingFolders}
            on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${item.id}
            and ${recordingFolders.userId} = ${viewer.orgUserId}
    )`;
}

/** SQL: an own task belongs exclusively to its author. */
export function personalTask(viewer: TaskViewer): SQL {
    if (viewer.isOrg) return sql`false`;
    return and(
        eq(recordingTasks.source, "personal"),
        eq(recordingTasks.userId, viewer.userId),
    ) as SQL;
}

/** SQL: the scoped task has a linked mail source, including a source hidden after a merge. */
export function taskNoteHasMailSource(): SQL {
    return sql`exists (
        select 1 from ${taskMentions}
        inner join ${chatterItems} mail_source on mail_source.id = ${taskMentions.itemId}
        where ${taskMentions.taskId} = ${recordingTasks.id}
            and ${taskMentions.matchDecision} in ('home', 'accepted')
            and mail_source.kind = 'mail'
    )`;
}

/** SQL: the viewer may see the task on the joined item, optionally including own tasks. */
export function taskVisible(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
    includePersonal = false,
): SQL {
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isOrg) return shared;
    return or(
        eq(item.userId, viewer.userId),
        shared,
        includePersonal ? personalTask(viewer) : undefined,
    ) as SQL;
}

/** SQL: the task is assigned to the viewer (needs nothing joined). */
export function assignedToViewer(viewer: TaskViewer): SQL {
    return or(
        personalTask(viewer),
        sql`exists (
        select 1 from ${people}
        where ${people.id} = ${recordingTasks.assigneePersonId}
            and ${people.primaryEmailHash} = ${viewer.emailHash}
    )`,
    ) as SQL;
}

/** SQL: follows currently visible to their viewer, including automatic follows unless removed. */
export function taskFollowed(
    viewer: TaskViewer,
    item: TaskItemColumns = ANY_TASK_ITEM,
): SQL {
    if (viewer.isOrg) return taskRecordingShared(viewer, item);
    return and(
        taskVisible(viewer, item, true),
        sql`not exists (select 1 from ${taskUnfollows} where ${taskUnfollows.taskId} = ${recordingTasks.id} and ${taskUnfollows.userId} = ${viewer.userId})`,
        or(
            sql`exists (select 1 from ${taskFollowers} where ${taskFollowers.taskId} = ${recordingTasks.id} and ${taskFollowers.userId} = ${viewer.userId})`,
            and(
                eq(item.userId, viewer.userId),
                sql`not (${assignedToViewer(viewer)})`,
            ),
        ),
    ) as SQL;
}
