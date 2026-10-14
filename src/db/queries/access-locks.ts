import { sql } from "drizzle-orm";
import type { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialize access changes across every app process: one lock per target
 * subject, and one shared lock for every change that can affect who
 * administers access (taken first, so the order is always the same).
 * Held until the transaction ends. Waiting for it gives up after ten
 * seconds (SQLSTATE 55P03, see {@link isAccessLockTimeout}), so waiters
 * holding pooled connections never starve the holder of one.
 */
export async function lockAccessChange(
    tx: Tx,
    subject: string,
    affectsAdministrators: boolean,
): Promise<void> {
    await tx.execute(sql`set local lock_timeout = '10s'`);
    if (affectsAdministrators) {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('chatterbox:access-admins', 0))`,
        );
    }
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chatterbox:access:${subject}`}, 0))`,
    );
}

/** Whether an error is {@link lockAccessChange} giving up its wait. */
export function isAccessLockTimeout(error: unknown): boolean {
    const value = error as { code?: unknown; cause?: { code?: unknown } };
    return value?.code === "55P03" || value?.cause?.code === "55P03";
}
