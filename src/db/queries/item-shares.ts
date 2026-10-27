import { type AnyColumn, and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";

export {
    activeShareRecipientCondition,
    activeShareRecipientExistsCondition,
} from "@/db/queries/share-recipients";

import {
    chatterItems,
    folderShares,
    itemShares,
    receivedFolderAttachments,
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
    return sql`${itemId} in (
        select ${itemShares.itemId} from ${itemShares}
        inner join chatter_items direct_item on direct_item.id = ${itemShares.itemId}
            and direct_item.user_id = ${itemShares.userId} and direct_item.kind in ('audio', 'mail')
        inner join ${users} on ${users.id} = ${itemShares.receiverUserId}
        where ${itemShares.receiverUserId} = ${receiverUserId}
          and ${itemShares.state} = 'accepted'
          and ${activeShareRecipientCondition()}
        union all
        ${receivedFolderItemIds(receiverUserId)}
    )`;
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
    return sql`${itemId} in (${receivedFolderItemIds(receiverUserId, attachmentId, since)})`;
}

function receivedFolderItemIds(
    receiverUserId: string,
    attachmentId?: string,
    since?: Date,
) {
    return sql`select ${recordingFolderAssignments.itemId} from (
        select ${recordingFolders.id} from ${recordingFolders}
        where ${recordingFolders.userId} = ${receiverUserId}
            and ${recordingFolders.kind} = 'custom'
        union
        select ${recordingFolders.id} from ${folderShares}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${folderShares.folderId}
            and ${recordingFolders.userId} = ${folderShares.userId}
        inner join ${users} on ${users.id} = ${folderShares.receiverUserId}
        where ${folderShares.receiverUserId} = ${receiverUserId}
            and ${folderShares.state} = 'accepted'
            and ${activeShareRecipientCondition()}
            and ${recordingFolders.kind} = 'custom'
    ) eligible_folders
        inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.folderId} = eligible_folders.id
        inner join ${recordingFolders} on ${recordingFolders.id} = eligible_folders.id
        inner join ${chatterItems} on ${chatterItems.id} = ${recordingFolderAssignments.itemId}
            and ${chatterItems.userId} = ${recordingFolderAssignments.userId}
        where ${folderParticipantCondition(recordingFolders.userId, chatterItems.userId, recordingFolders.id)}
            and ${chatterItems.userId} <> ${receiverUserId}
            and ${recordingFolders.kind} = 'custom'
            ${
                attachmentId
                    ? sql`and exists (select 1 from ${receivedFolderAttachments}
                inner join ${folderShares} on ${folderShares.id} = ${receivedFolderAttachments.shareId}
                where ${receivedFolderAttachments.id} = ${attachmentId}
                  and ${receivedFolderAttachments.userId} = ${receiverUserId}
                  and ${folderShares.receiverUserId} = ${receiverUserId}
                  and ${folderShares.folderId} = ${recordingFolders.id}
                  and ${folderShares.state} = 'accepted')`
                    : sql``
            }
            ${
                since
                    ? sql`and (${recordingFolderAssignments.createdAt} > ${since.toISOString()}::timestamp
                or exists (select 1 from ${folderShares} where ${folderShares.folderId} = ${recordingFolders.id}
                    and ${folderShares.receiverUserId} = ${receiverUserId} and ${folderShares.state} = 'accepted'
                    and ${folderShares.respondedAt} > ${since.toISOString()}::timestamp))`
                    : sql``
            }`;
}

/** Whether an owner's item has a current direct or direct-folder person invitation. */
export function outgoingItemShareCondition(ownerUserId: string) {
    if (!isOrgScopeVisible()) return sql<boolean>`false`;
    return sql<boolean>`${chatterItems.id} in (
        select ${itemShares.itemId} from ${itemShares}
        where ${itemShares.userId} = ${ownerUserId}
            and ${itemShares.state} in ('pending', 'accepted')
        union all
        select ${recordingFolderAssignments.itemId} from ${folderShares}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${folderShares.folderId}
            and ${recordingFolders.userId} = ${folderShares.userId}
        inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.folderId} = ${folderShares.folderId}
            and ${folderParticipantCondition(folderShares.userId, recordingFolderAssignments.userId, folderShares.folderId)}
        inner join ${chatterItems} on ${chatterItems.id} = ${recordingFolderAssignments.itemId}
            and ${chatterItems.userId} = ${recordingFolderAssignments.userId}
        where ${chatterItems.userId} = ${ownerUserId}
            and ${folderShares.state} in ('pending', 'accepted')
            and ${recordingFolders.kind} = 'custom'
    )`;
}

/** Items with active outgoing invitations, for the owner's library markers. */
export async function listOutgoingSharedItemIds(ownerUserId: string) {
    if (!isOrgScopeVisible()) return new Set<string>();
    const rows = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
                outgoingItemShareCondition(ownerUserId),
            ),
        );
    return new Set(rows.map((row) => row.id));
}

/** Commit a content-free refresh for accepted folder receivers after placement changes. */
export async function notifyFolderReceiversInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ownerUserId: string,
    itemId: string,
    folderId?: string,
): Promise<void> {
    if (!isOrgScopeVisible()) return;
    await tx.execute(sql`with eligible_folders as (
        select ${recordingFolders.id}, ${recordingFolders.userId} from ${recordingFolderAssignments}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        inner join ${chatterItems} on ${chatterItems.id} = ${recordingFolderAssignments.itemId}
            and ${chatterItems.userId} = ${recordingFolderAssignments.userId}
        where ${recordingFolderAssignments.userId} = ${ownerUserId}
          and ${recordingFolderAssignments.itemId} = ${itemId}
          and ${folderParticipantCondition(recordingFolders.userId, recordingFolderAssignments.userId, recordingFolders.id)}
          and ${recordingFolders.kind} = 'custom'
          ${folderId ? sql`and ${recordingFolders.id} = ${folderId}` : sql``}
    ), recipients as (
        select user_id as id from eligible_folders
        union
        select ${folderShares.receiverUserId} as id from eligible_folders
        inner join ${folderShares} on ${folderShares.folderId} = eligible_folders.id
            and ${folderShares.userId} = eligible_folders.user_id
        inner join ${users} on ${users.id} = ${folderShares.receiverUserId}
        where ${folderShares.state} = 'accepted' and ${activeShareRecipientCondition()}
    )
    select pg_notify(${"riffado_personal"}, json_build_object('type', 'share', 'userId', recipients.id)::text)
    from recipients where recipients.id <> ${ownerUserId}`);
}
