import { type AnyColumn, and, asc, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
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

function startsWithWords(column: AnyColumn, terms: readonly string[]) {
    const diacritics =
        "[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]";
    const folded = sql`regexp_replace(normalize(lower(${column}), NFD), ${diacritics}, '', 'g')`;
    return and(
        ...terms.map((term) => sql`${folded} ~ ${`(^|[^[:alnum:]])${term}`}`),
    );
}

/** Search the active colleague directory, excluding the caller. */
export function searchShareRecipients(
    userId: string,
    terms: readonly string[],
) {
    return db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
            and(
                ne(users.id, userId),
                activeShareRecipientCondition(),
                or(
                    startsWithWords(users.name, terms),
                    startsWithWords(users.email, terms),
                ),
            ),
        )
        .orderBy(asc(users.name), asc(users.id))
        .limit(10);
}
