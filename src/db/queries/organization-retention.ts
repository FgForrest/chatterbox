import { type AnyColumn, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";

/** An open Organization placement governs retention only after its release grace has elapsed. */
export function organizationRetentionCondition(
    orgUserId: string,
    itemId: AnyColumn = chatterItems.id,
    now = Date.now(),
) {
    const graceBefore = new Date(now - 30 * 86400000).toISOString();
    return sql`exists (select 1 from ${recordingFolderAssignments}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${itemId}
        and ${recordingFolders.userId} = ${orgUserId}
        and ${recordingFolders.restrictedAt} is null and not ${recordingFolderAssignments.withheld}
        and (${recordingFolderAssignments.releasedAt} is null or ${recordingFolderAssignments.releasedAt} <= ${graceBefore}::timestamp))`;
}

/** Recheck the policy boundary under the item lock, including the exact 30-day edge. */
export async function organizationGovernsRetention(
    executor: Pick<typeof db, "select">,
    orgUserId: string,
    itemId: string,
    at: Date,
) {
    const [row] = await executor
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            sql`${chatterItems.id} = ${itemId} and ${organizationRetentionCondition(orgUserId, chatterItems.id, at.getTime())}`,
        )
        .limit(1);
    return !!row;
}
