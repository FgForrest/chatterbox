import { type AnyColumn, and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, itemShares, userAccessStates, users } from "@/db/schema";
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

/** SQL predicate for accepted person shares, independent of Organization publication. */
export function receivedItemCondition(
    receiverUserId: string,
    itemId: AnyColumn = chatterItems.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`exists (
        select 1 from ${itemShares}
        inner join ${users} on ${users.id} = ${itemShares.receiverUserId}
        where ${itemShares.itemId} = ${itemId}
          and ${itemShares.receiverUserId} = ${receiverUserId}
          and ${itemShares.state} = 'accepted'
          and ${activeShareRecipientCondition()}
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
    return sql`exists (select 1 from ${itemShares} where ${itemShares.itemId} = ${itemId}
        and ${itemShares.receiverUserId} = ${receiverUserId} and ${itemShares.state} = 'accepted'
        and ${itemShares.respondedAt} > ${seen.toISOString()}::timestamp)`;
}
