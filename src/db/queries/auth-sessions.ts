import { sql } from "drizzle-orm";
import { db } from "@/db";
import { sessions, verifications } from "@/db/schema";

/**
 * Delete up to `limit` sign-in sessions that expired before `expiredBefore`.
 * Better Auth only removes an expired session when it is presented again, so
 * one abandoned on a device stays otherwise. Rows another process is already
 * deleting are skipped.
 */
export async function pruneExpiredSessions(
    expiredBefore: Date,
    limit: number,
): Promise<number> {
    const rows = await db.execute<{ id: string }>(sql`
        delete from ${sessions}
        where id in (
            select id
            from ${sessions}
            where expires_at < ${expiredBefore.toISOString()}::timestamp
            order by expires_at asc
            limit ${limit}
            for update skip locked
        )
        returning id
    `);
    return rows.length;
}

/**
 * Delete up to `limit` verification values (sign-in codes, reset tokens)
 * that expired before `expiredBefore`; Better Auth rejects them once
 * expired. Rows another process is already deleting are skipped.
 */
export async function pruneExpiredVerifications(
    expiredBefore: Date,
    limit: number,
): Promise<number> {
    const rows = await db.execute<{ id: string }>(sql`
        delete from ${verifications}
        where id in (
            select id
            from ${verifications}
            where expires_at < ${expiredBefore.toISOString()}::timestamp
            order by expires_at asc
            limit ${limit}
            for update skip locked
        )
        returning id
    `);
    return rows.length;
}
