import { sql } from "drizzle-orm";
import { asyncJobs } from "@/db/schema";

/**
 * A job still to be finished. Also the predicate of `async_jobs_active_unique`,
 * which `enqueueJob` names as its conflict target, so the two must match.
 */
export function isActive() {
    return sql`${asyncJobs.status} in ('pending', 'processing')`;
}
