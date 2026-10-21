import { sql } from "drizzle-orm";
import type { db } from "@/db";

type Executor = Pick<typeof db, "execute">;

/** Serialize profile lifecycle and pointer writes for the authorized owner. */
export async function lockProfileMutation(
    executor: Executor,
    ownerUserId: string,
): Promise<void> {
    await executor.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`profile-owner:${ownerUserId}`}, 0))`,
    );
}
