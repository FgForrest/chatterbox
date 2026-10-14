import { sql } from "drizzle-orm";
import type { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialize access changes across every app process: one lock per target
 * subject, and one shared lock for every change that can affect who
 * administers access (taken first, so the order is always the same).
 * Held until the transaction ends.
 */
export async function lockAccessChange(
    tx: Tx,
    subject: string,
    affectsAdministrators: boolean,
): Promise<void> {
    if (affectsAdministrators) {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('chatterbox:access-admins', 0))`,
        );
    }
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chatterbox:access:${subject}`}, 0))`,
    );
}
