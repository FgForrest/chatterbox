import { sql } from "drizzle-orm";
import type { db } from "@/db";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import {
    chatterItems,
    folderShares,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";

type Executor = Pick<typeof db, "execute">;

/** The live folder audience of an owner's assignments, including pending folder recipients. */
export function ownerItemFolderAudienceRows(
    ownerUserId: string,
    itemId?: string,
) {
    return sql`with placements as (
        select ${chatterItems.id} as item_id, ${recordingFolders.id} as folder_id,
            ${recordingFolders.userId} as folder_owner_id,
            case when ${recordingFolders.userId} = ${ownerUserId}
                then ${recordingFolders.name} else ${receivedFolderAttachments.name} end as folder_name
        from ${chatterItems}
        inner join ${recordingFolderAssignments}
            on ${recordingFolderAssignments.itemId} = ${chatterItems.id}
            and ${recordingFolderAssignments.userId} = ${chatterItems.userId}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        left join ${folderShares} owner_attachment_share
            on owner_attachment_share.folder_id = ${recordingFolders.id}
            and owner_attachment_share.user_id = ${recordingFolders.userId}
            and owner_attachment_share.receiver_user_id = ${ownerUserId}
            and owner_attachment_share.state = 'accepted'
        left join ${receivedFolderAttachments}
            on ${receivedFolderAttachments.shareId} = owner_attachment_share.id
            and ${receivedFolderAttachments.userId} = ${ownerUserId}
        where ${chatterItems.userId} = ${ownerUserId}
            and ${chatterItems.deletedAt} is null
            and ${recordingFolders.kind} = 'custom'
            and ${folderParticipantCondition(recordingFolders.userId, chatterItems.userId, recordingFolders.id)}
            ${itemId ? sql`and ${chatterItems.id} = ${itemId}` : sql``}
    ), audience as (
        select placements.*, folder_owner_id as receiver_user_id, 'accepted'::text as state from placements
        union all
        select placements.*, ${folderShares.receiverUserId} as receiver_user_id, ${folderShares.state} as state
        from placements inner join ${folderShares}
            on ${folderShares.folderId} = placements.folder_id
            and ${folderShares.userId} = placements.folder_owner_id
        where ${folderShares.state} in ('pending', 'accepted')
    )
    select audience.item_id, audience.folder_id, audience.folder_name,
        (audience.folder_owner_id = ${ownerUserId}) as can_manage,
        audience.receiver_user_id, ${users.name}, ${users.email}, audience.state
    from audience inner join ${users} on ${users.id} = audience.receiver_user_id
    where audience.receiver_user_id <> ${ownerUserId} and ${activeShareRecipientCondition()}`;
}

/** Owner-scoped audience rows; folder names are encrypted until the sharing boundary. */
export async function queryItemFolderAudience(
    executor: Executor,
    ownerUserId: string,
    itemId: string,
) {
    if (!isOrgScopeVisible()) return [];
    const rows = await executor.execute<{
        item_id: string;
        folder_id: string;
        folder_name: string | null;
        can_manage: boolean;
        receiver_user_id: string;
        name: string | null;
        email: string;
        state: "pending" | "accepted";
    }>(ownerItemFolderAudienceRows(ownerUserId, itemId));
    return [...rows];
}
