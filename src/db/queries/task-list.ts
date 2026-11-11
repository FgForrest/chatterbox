import { isNull, ne, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { receivedItemCondition } from "@/db/queries/item-shares";
import { placementVisibleCondition } from "@/db/queries/restricted-folders";
import { activeShareRecipientExistsCondition } from "@/db/queries/share-recipients";
import {
    ANY_TASK_ITEM,
    assignedToViewer,
    type TaskViewer,
    taskFollowed,
    taskRecordingShared,
    taskVisible,
} from "@/db/queries/task-visibility";
import {
    chatterItems,
    folderShares,
    itemShares,
    people,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskFollowers,
} from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";
import type { TaskTab } from "@/lib/tasks/tasks";

/** Accepted, live tasks visible in a Tasks page tab, before list filters and limits. */
export function taskTabConditions(
    viewer: TaskViewer,
    tab: TaskTab,
    organization = false,
): SQL[] {
    return [
        ne(recordingTasks.status, "proposed"),
        isNull(chatterItems.deletedAt),
        sql`(${chatterItems.id} is null or ${chatterItems.kind} in ('audio', 'mail'))`,
        taskVisible(viewer, ANY_TASK_ITEM, true),
        taskTabScope(viewer, tab, organization),
    ];
}

function taskTabScope(
    viewer: TaskViewer,
    tab: TaskTab,
    organization: boolean,
): SQL {
    if (tab === "all") return sql`true`;
    if (tab === "mine") return assignedToViewer(viewer);
    if (organization && viewer.isCurator) {
        return taskRecordingShared(viewer, ANY_TASK_ITEM);
    }
    return taskFollowed(viewer);
}

function taskFolderSource(
    viewer: TaskViewer,
    tab: TaskTab,
    organization: boolean,
): SQL {
    const columns = sql.join(
        [
            recordingTasks.id,
            recordingTasks.itemId,
            recordingTasks.folderId,
            recordingTasks.source,
            recordingTasks.userId,
            recordingTasks.status,
            recordingTasks.assigneePersonId,
        ],
        sql`, `,
    );
    if (tab === "mine")
        return sql`(
        select ${columns} from ${recordingTasks}
        where ${recordingTasks.userId} = ${viewer.userId} and ${recordingTasks.source} = 'personal'
        union all
        select ${columns} from ${people}
        inner join ${recordingTasks} on ${recordingTasks.assigneePersonId} = ${people.id}
        where ${people.primaryEmailHash} = ${viewer.emailHash}
    ) ${recordingTasks}`;
    if (
        (tab === "followed" || tab === "tracked") &&
        !viewer.isOrg &&
        !(organization && viewer.isCurator)
    )
        return sql`(
        select ${columns} from ${taskFollowers}
        inner join ${recordingTasks} on ${recordingTasks.id} = ${taskFollowers.taskId}
        where ${taskFollowers.userId} = ${viewer.userId}
        union all
        select ${columns} from ${chatterItems}
        inner join ${recordingTasks} on ${recordingTasks.itemId} = ${chatterItems.id}
        where ${chatterItems.userId} = ${viewer.userId}
    ) ${recordingTasks}`;
    return sql`${recordingTasks}`;
}

/** Distinct readable placements of a tab's tasks, without loading task content or counts. */
export async function listTaskFolderIds(
    viewer: TaskViewer,
    tab: TaskTab,
    organization = false,
): Promise<string[]> {
    if (tab === "mine" && viewer.isOrg) return [];
    const conditions = sql.join(
        taskTabConditions(viewer, tab, organization),
        sql` and `,
    );
    const personal = !viewer.isOrg;
    const includeOwn = personal && (tab === "mine" || tab === "all");
    const received = personal && isOrgScopeVisible();
    const rows = await db.execute<{ id: string }>(sql`
        with visible_tasks as materialized (
            select distinct ${recordingTasks.itemId} as item_id,
                ${chatterItems.userId} as item_owner,
                ${recordingTasks.folderId} as folder_id,
                ${recordingTasks.source} as source
            from ${taskFolderSource(viewer, tab, organization)}
            left join ${chatterItems} on ${chatterItems.id} = ${recordingTasks.itemId}
            where ${conditions}
        )
        select ${recordingFolders.id} as id from visible_tasks task
        inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.itemId} = task.item_id
            and ${recordingFolderAssignments.userId} = task.item_owner
        inner join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where (
            (${personal} and ${recordingFolders.userId} = ${viewer.userId}
                and ${folderParticipantCondition(recordingFolders.userId, recordingFolderAssignments.userId, recordingFolders.id)})
            or (${recordingFolders.userId} = ${viewer.orgUserId}
                and ${placementVisibleCondition(viewer)})
        )
        union
        select ${receivedFolderAttachments.id} as id from visible_tasks task
        inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.itemId} = task.item_id
            and ${recordingFolderAssignments.userId} = task.item_owner
        inner join ${folderShares} on ${folderShares.folderId} = ${recordingFolderAssignments.folderId}
            and ${folderShares.receiverUserId} = ${viewer.userId} and ${folderShares.state} = 'accepted'
        inner join ${recordingFolders} on ${recordingFolders.id} = ${folderShares.folderId}
            and ${recordingFolders.userId} = ${folderShares.userId}
        inner join ${receivedFolderAttachments} on ${receivedFolderAttachments.shareId} = ${folderShares.id}
            and ${receivedFolderAttachments.userId} = ${viewer.userId}
        where ${received} and ${activeShareRecipientExistsCondition(viewer.userId)}
            and ${folderParticipantCondition(recordingFolders.userId, recordingFolderAssignments.userId, recordingFolders.id)}
        union
        select ${recordingFolders.id} as id from visible_tasks task
        inner join ${itemShares} on ${itemShares.itemId} = task.item_id
            and ${itemShares.receiverUserId} = ${viewer.userId} and ${itemShares.state} = 'accepted'
        inner join ${chatterItems} on ${chatterItems.id} = task.item_id
        inner join ${recordingFolders} on ${recordingFolders.id} = ${itemShares.filingFolderId}
            and ${recordingFolders.userId} = ${viewer.userId}
        where ${received} and ${receivedItemCondition(viewer.userId, chatterItems.id, viewer.isCurator)}
        union
        select ${recordingFolders.id} as id from visible_tasks task
        inner join ${recordingFolders} on ${recordingFolders.id} = task.folder_id
            and ${recordingFolders.userId} = ${viewer.userId}
        where ${includeOwn} and task.source = 'personal'
        union
        select ${recordingFolders.id} as id from ${recordingFolders}
        where ${personal} and ${recordingFolders.userId} = ${viewer.userId}
            and ${recordingFolders.kind} = 'private'
            and exists (
                select 1 from visible_tasks task
                left join ${chatterItems} on ${chatterItems.id} = task.item_id
                where (${includeOwn} and task.source = 'personal')
                    or task.item_owner = ${viewer.userId}
                    or (${received} and ${receivedItemCondition(viewer.userId, chatterItems.id, viewer.isCurator)})
            )
    `);
    return rows.map((row) => row.id);
}
