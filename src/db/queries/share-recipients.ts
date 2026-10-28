import { type AnyColumn, sql } from "drizzle-orm";
import { userAccessStates, users } from "@/db/schema";
import { isIdpAuthorization } from "@/lib/identity/factory";

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
export function activeShareRecipientExistsCondition(
    receiverUserId: string | AnyColumn,
) {
    return sql`exists (select 1 from ${users} active_recipient
        where active_recipient.id = ${receiverUserId}
          and active_recipient.role <> 'org' and active_recipient.suspended_at is null
          ${
              isIdpAuthorization()
                  ? sql`and exists (select 1 from ${userAccessStates} recipient_access
            where recipient_access.user_id = active_recipient.id and recipient_access.status = 'active'
              and recipient_access.capabilities @> '["use"]'::jsonb)`
                  : sql``
          })`;
}
