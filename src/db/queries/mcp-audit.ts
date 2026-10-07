import { sql } from "drizzle-orm";
import { db } from "@/db";
import { mcpAccessLog } from "@/db/schema";

const DAY_MS = 86_400_000;

/**
 * Delete up to `limit` MCP access-log rows older than `olderThanDays`;
 * returns how many went.
 */
export async function pruneMcpAccessLog(
    olderThanDays: number,
    limit = 5_000,
): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
    const rows = await db.execute<{ n: number }>(sql`
        with doomed as (
            select ${mcpAccessLog.id} as id
            from ${mcpAccessLog}
            where ${mcpAccessLog.at} < ${cutoff}::timestamp
            limit ${limit}
        ), deleted as (
            delete from ${mcpAccessLog}
            where ${mcpAccessLog.id} in (select id from doomed)
            returning 1
        )
        select count(*)::int as n from deleted
    `);
    return Number(rows[0]?.n ?? 0);
}
