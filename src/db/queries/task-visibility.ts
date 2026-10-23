import { type AnyColumn, and, eq, not, or, type SQL, sql } from "drizzle-orm";
import { receivedItemCondition } from "@/db/queries/item-shares";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
} from "@/db/schema";

/**
 * Who may do what with a task (maintainer, 2026-10-07; person shares 2026-10-22):
 *
 * | action                   | private recording | shared with people                  | shared recording                          |
 * |--------------------------|-------------------|-------------------------------------|-------------------------------------------|
 * | edit, add, drop, review  | owner             | owner                               | home owner, curator                        |
 * | done, reopen             | owner             | owner, assignee among receivers     | home owner, assignee, curator              |
 * | see                      | owner             | owner, receivers; list: assignee    | everyone; list: owner, assignee, curator   |
 *
 * A task on a private recording reaches nobody but its owner and the people
 * it is shared with, even when it names someone else: tasks travel only
 * through the Organization or a person share. While a recording is also in
 * the Organization, the Organization rules win. The assignee is a user when
 * their person's email is that user's login email.
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
    includeReceived?: boolean;
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
    return or(
        eq(item.userId, viewer.userId),
        shared,
        taskReceived(viewer, item),
    ) as SQL;
}

/** SQL: an accepted person share grants receiver-only rights while the item is private. */
export function taskReceived(
    viewer: TaskViewer,
    item: TaskItemColumns = RECORDING_TASK_ITEM,
): SQL {
    return viewer.isOrg || viewer.includeReceived !== true
        ? sql`false`
        : (and(
              receivedItemCondition(viewer.userId, item.id),
              not(taskRecordingShared(viewer, item)),
          ) as SQL);
}
