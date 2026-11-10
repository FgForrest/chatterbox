import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Folder ids in an owner's item scope, including descendants and excluding roots. */
export async function queryItemScopeFolderIds(input: {
    itemId: string;
    view: "private" | "org";
    ownerUserId: string;
    orgUserId: string | null;
}): Promise<string[]> {
    const rows = await db.execute<{ id: string }>(sql`
        with recursive placed_folders as (
            select a.folder_id
            from recording_folder_assignments a
            join chatter_items item
              on item.id = a.recording_id
             and item.user_id = ${input.ownerUserId}
            where a.recording_id = ${input.itemId}
              and a.user_id = ${input.ownerUserId}
              and (${input.view} = 'private' or not a.withheld)
              and item.deleted_at is null
            union
            select pending.folder_id
            from mail_pending_shares pending
            join chatter_items item
              on item.id = pending.item_id
             and item.user_id = ${input.ownerUserId}
            where pending.item_id = ${input.itemId}
              and pending.user_id = ${input.ownerUserId}
              and (${input.view} = 'private' or not exists (select 1 from recording_folder_assignments withheld_intent where withheld_intent.recording_id = pending.item_id and withheld_intent.folder_id = pending.folder_id and withheld_intent.withheld))
              and item.deleted_at is null
        ), scope_folders as (
            select folder.id, folder.user_id, folder.parent_id
            from recording_folders folder
            join placed_folders placed on placed.folder_id = folder.id
            where (
                (${input.view} = 'private' and (
                    folder.user_id = ${input.ownerUserId}
                    or folder.user_id = ${input.orgUserId}
                ) and (folder.restricted_at is null or exists (select 1 from restricted_folder_members member where member.folder_id = folder.id and member.user_id = ${input.ownerUserId})))
                or (${input.view} = 'org' and folder.user_id = ${input.orgUserId} and folder.restricted_at is null)
              )
            union
            select child.id, child.user_id, child.parent_id
            from recording_folders child
            join scope_folders parent
              on child.parent_id = parent.id
             and child.user_id = parent.user_id
            where child.restricted_at is null or (${input.view} = 'private' and exists (select 1 from restricted_folder_members member where member.folder_id = child.id and member.user_id = ${input.ownerUserId}))
        )
        select distinct id
        from scope_folders
        where parent_id is not null
        order by id
    `);
    return rows.map((row) => row.id);
}
