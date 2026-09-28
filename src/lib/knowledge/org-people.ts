import { type Column, sql } from "drizzle-orm";
import type { db } from "@/db";
import { users } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ORG_PEOPLE_LOCK = sql`hashtext('riffado:org-people')`;

/**
 * SQL predicate: the row belongs to the organization account.
 *
 * By role rather than by a configured id, so knowledge code needs neither
 * the environment nor the org account's id, and an Organization person
 * keeps resolving if the scope is later switched off.
 */
export function orgOwnedCondition(column: Column) {
    return sql`${column} in (select ${users.id} from ${users} where ${users.role} = 'org')`;
}

/**
 * Serialize promotions, so two recordings shared at once cannot both create
 * an Organization person for the same email, and a delete or merge cannot
 * act on a private person a share is promoting.
 *
 * Taken before any recording lock: a promotion may merge people, and a
 * merge locks the recordings that name them.
 */
export async function lockOrgPeople(tx: Tx): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${ORG_PEOPLE_LOCK})`);
}

/**
 * The same lock, shared, for a writer that names a person or an entity
 * (a correction, a fact, an alias, notes, a speaker answer). A merge,
 * promotion or deletion holds it exclusive from before it reads what it
 * moves until it commits, so the writer resolves its target after it and
 * never writes onto a record about to become a tombstone. Writers do not
 * wait for one another. Taken first, before any recording lock, as above.
 */
export async function lockOrgPeopleShared(tx: Tx): Promise<void> {
    await tx.execute(
        sql`select pg_advisory_xact_lock_shared(${ORG_PEOPLE_LOCK})`,
    );
}
