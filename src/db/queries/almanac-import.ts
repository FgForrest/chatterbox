import { sql } from "drizzle-orm";
import type { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize imports into the same account's knowledge scope. */
export async function lockAlmanacImport(
    tx: Tx,
    scopeUserId: string,
): Promise<void> {
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`riffado:import:${scopeUserId}`}))`,
    );
}
