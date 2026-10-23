import { type AnyColumn, and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    folderShares,
    itemShares,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    userAccessStates,
    users,
} from "@/db/schema";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { isOrgScopeVisible } from "@/lib/org/config";

/** SQL predicate for a member who can receive invitations in the current authorization mode. */
export function activeShareRecipientCondition() {
    return sql`${users.role} <> 'org' and ${users.suspendedAt} is null
        ${
            isIdpAuthorization()
                ? sql`and exists (
            select 1 from ${userAccessStates}
            where ${userAccessStates.userId} = ${users.id}
              and ${userAccessStates.status} = 'active'
              and ${userAccessStates.capabilities} @> '["use"]'::jsonb
        )`
                : sql``
        }`;
}

/** SQL predicate for an active recipient without joining the caller's outer user table. */
export function activeShareRecipientExistsCondition(receiverUserId: string) {
    return sql`exists (select 1 from ${users}
        where ${users.id} = ${receiverUserId}
          and ${activeShareRecipientCondition()})`;
}

/** SQL predicate for accepted person shares, independent of Organization publication. */
export function receivedItemCondition(
    receiverUserId: string,
    itemId: AnyColumn = chatterItems.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`${itemId} in (
        select ${itemShares.itemId} from ${itemShares}
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
    return sql`select ${recordingFolderAssignments.itemId} from ${folderShares}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${folderShares.folderId}
            and ${recordingFolders.userId} = ${folderShares.userId}
        inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.folderId} = ${folderShares.folderId}
            and ${recordingFolderAssignments.userId} = ${folderShares.userId}
        inner join ${chatterItems} on ${chatterItems.id} = ${recordingFolderAssignments.itemId}
            and ${chatterItems.userId} = ${folderShares.userId}
        inner join ${users} on ${users.id} = ${folderShares.receiverUserId}
        ${attachmentId ? sql`inner join ${receivedFolderAttachments} on ${receivedFolderAttachments.shareId} = ${folderShares.id} and ${receivedFolderAttachments.userId} = ${receiverUserId}` : sql``}
        where ${folderShares.receiverUserId} = ${receiverUserId}
            and ${folderShares.state} = 'accepted'
            and ${recordingFolders.kind} = 'custom'
            and ${activeShareRecipientCondition()}
            ${attachmentId ? sql`and ${receivedFolderAttachments.id} = ${attachmentId}` : sql``}
            ${since ? sql`and greatest(${folderShares.respondedAt}, ${recordingFolderAssignments.createdAt}) > ${since.toISOString()}::timestamp` : sql``}`;
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
            and ${recordingFolderAssignments.userId} = ${folderShares.userId}
        inner join ${chatterItems} on ${chatterItems.id} = ${recordingFolderAssignments.itemId}
            and ${chatterItems.userId} = ${folderShares.userId}
        where ${folderShares.userId} = ${ownerUserId}
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
    await tx.execute(sql`select pg_notify(${"riffado_personal"},
        json_build_object('type', 'share', 'userId', recipients.receiver_user_id)::text)
        from (select distinct ${folderShares.receiverUserId} as receiver_user_id
              from ${folderShares}
              inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.folderId} = ${folderShares.folderId}
                and ${recordingFolderAssignments.userId} = ${ownerUserId}
              inner join ${recordingFolders} on ${recordingFolders.id} = ${folderShares.folderId}
                and ${recordingFolders.userId} = ${ownerUserId}
              inner join ${chatterItems} on ${chatterItems.id} = ${recordingFolderAssignments.itemId}
                and ${chatterItems.userId} = ${ownerUserId}
              inner join ${users} on ${users.id} = ${folderShares.receiverUserId}
              where ${folderShares.userId} = ${ownerUserId}
                and ${folderShares.state} = 'accepted'
                and ${recordingFolderAssignments.itemId} = ${itemId}
                and ${recordingFolders.kind} = 'custom'
                ${folderId ? sql`and ${folderShares.folderId} = ${folderId}` : sql``}
                and ${activeShareRecipientCondition()}) recipients`);
}
