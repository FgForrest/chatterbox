import { type AnyColumn, and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    folderShares,
    itemShares,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";

/** SQL predicate for accepted person shares, independent of Organization publication. */
export function receivedItemCondition(
    receiverUserId: string,
    itemId: AnyColumn = chatterItems.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`(exists (
        select 1 from ${itemShares}
        inner join ${users} on ${users.id} = ${itemShares.receiverUserId}
        where ${itemShares.itemId} = ${itemId}
          and ${itemShares.receiverUserId} = ${receiverUserId}
          and ${itemShares.state} = 'accepted'
          and ${users.role} <> 'org'
    ) or ${receivedThroughFolderCondition(receiverUserId, itemId)})`;
}

/** Whether the caller has an accepted invitation for this item. */
export async function isItemReceived(
    receiverUserId: string,
    itemId: string,
): Promise<boolean> {
    if (!isOrgScopeVisible()) return false;
    const rows = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                receivedItemCondition(receiverUserId),
            ),
        )
        .limit(1);
    return rows.length > 0;
}

/** SQL predicate for an accepted invitation that arrived since the receiver saw their task list. */
export function receivedItemSinceCondition(
    receiverUserId: string,
    seen: Date,
    itemId: AnyColumn = chatterItems.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`(exists (select 1 from ${itemShares} where ${itemShares.itemId} = ${itemId}
        and ${itemShares.receiverUserId} = ${receiverUserId} and ${itemShares.state} = 'accepted'
        and ${itemShares.respondedAt} > ${seen.toISOString()}::timestamp) or ${receivedThroughFolderCondition(receiverUserId, itemId, undefined, seen)})`;
}

/** Live direct membership of an accepted private folder share; never its descendants. */
export function receivedThroughFolderCondition(
    receiverUserId: string,
    itemId: AnyColumn = chatterItems.id,
    attachmentId?: string,
    since?: Date,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`exists (
        select 1 from ${folderShares}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${folderShares.folderId}
            and ${recordingFolders.userId} = ${folderShares.userId}
        inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.folderId} = ${folderShares.folderId}
            and ${recordingFolderAssignments.userId} = ${folderShares.userId}
        inner join ${users} on ${users.id} = ${folderShares.receiverUserId}
        ${attachmentId ? sql`inner join received_folder_attachments attachment on attachment.share_id = ${folderShares.id} and attachment.user_id = ${receiverUserId}` : sql``}
        where ${recordingFolderAssignments.itemId} = ${itemId}
            and ${folderShares.receiverUserId} = ${receiverUserId}
            and ${folderShares.state} = 'accepted'
            and ${recordingFolders.kind} = 'custom'
            and ${users.role} <> 'org'
            ${attachmentId ? sql`and attachment.id = ${attachmentId}` : sql``}
            ${since ? sql`and greatest(${folderShares.respondedAt}, ${recordingFolderAssignments.createdAt}) > ${since.toISOString()}::timestamp` : sql``}
    )`;
}

/** Commit a content-free refresh for accepted folder receivers after placement changes. */
export async function notifyFolderReceiversInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ownerUserId: string,
): Promise<void> {
    if (!isOrgScopeVisible()) return;
    await tx.execute(sql`select pg_notify(${"riffado_personal"},
        json_build_object('type', 'share', 'userId', recipients.receiver_user_id)::text)
        from (select distinct ${folderShares.receiverUserId} as receiver_user_id
              from ${folderShares}
              where ${folderShares.userId} = ${ownerUserId}
                and ${folderShares.state} = 'accepted') recipients`);
}
