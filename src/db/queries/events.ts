import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Publish an invalidation through PostgreSQL to every app process. */
export async function publishEvent(
    channel: string,
    event: object,
): Promise<void> {
    await db.execute(
        sql`select pg_notify(${channel}, ${JSON.stringify(event)})`,
    );
}
