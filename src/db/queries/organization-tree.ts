import { sql } from "drizzle-orm";
import type { db } from "@/db";

/** Serialize Organization placement, restriction and audience changes before item locks. */
export async function lockOrgTree(
    tx: Pick<typeof db, "execute">,
): Promise<void> {
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('riffado:org-tree'))`,
    );
}
