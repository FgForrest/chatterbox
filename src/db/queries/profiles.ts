import { sql } from "drizzle-orm";
import type { db } from "@/db";

type Executor = Pick<typeof db, "execute">;

/** Serialize lazy profile seeding for one owner across all application processes. */
export async function lockProfileSeedOwner(
    executor: Executor,
    ownerUserId: string,
): Promise<void> {
    await executor.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chatterbox:profile-seed:${ownerUserId}`}, 0))`,
    );
}
