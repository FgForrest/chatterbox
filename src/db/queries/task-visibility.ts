import { type AnyColumn, eq, or, type SQL, sql } from "drizzle-orm";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
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

/** SQL: the viewer may see the task on the joined item. */
export function taskVisible(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    const shared = taskRecordingShared(viewer, item);
    if (viewer.isOrg) return shared;
    return or(eq(item.userId, viewer.userId), shared) as SQL;
}
