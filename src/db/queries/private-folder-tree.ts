import { eq, sql } from "drizzle-orm";
import type { db } from "@/db";
import { users } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize filing and scope changes before locking tasks. A row write also invalidates stale serializable move snapshots. */
export async function lockPrivateFolderTree(
    tx: Tx,
    userId: string,
): Promise<void> {
    await tx
        .update(users)
        .set({ updatedAt: sql`${users.updatedAt}` })
        .where(eq(users.id, userId));
}
