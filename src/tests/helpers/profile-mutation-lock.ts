import { sql } from "drizzle-orm";
import type { db } from "@/db";

/** Observe an ungranted lifecycle lock for one owner in the current database. */
export async function hasWaitingProfileMutation(
    executor: Pick<typeof db, "execute">,
    ownerUserId: string,
): Promise<boolean> {
    const key = `profile-owner:${ownerUserId}`;
    const rows = await executor.execute<{ waiting: boolean }>(sql`
        select exists (
            select 1 from pg_locks
            where locktype = 'advisory' and not granted and objsubid = 1
                and database = (select oid from pg_database where datname = current_database())
                and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
                and objid::bigint = (hashtextextended(${key}, 0) & 4294967295)
        ) as waiting
    `);
    return rows[0]?.waiting ?? false;
}
