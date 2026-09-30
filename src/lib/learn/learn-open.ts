/**
 * When a Learn run is still open: ready for review, or queued or running
 * with its job alive. A run whose job is gone (buried after a crash, lost
 * between two statements) is dead however its row reads, so it blocks
 * neither a new run nor a share. A run not yet given its job is open for
 * a short while (the start inserts the run, then queues the job).
 *
 * Only schema and drizzle, so the share gate can use it.
 */

import { and, inArray, or, sql } from "drizzle-orm";
import { asyncJobs, learnRuns } from "@/db/schema";

/** How long a run may wait for its job to be queued. */
const JOB_GRACE = sql`interval '2 minutes'`;

/** SQL predicate: the run's job is queued or running. */
function jobAlive() {
    return sql`exists (select 1 from ${asyncJobs} where ${asyncJobs.id} = ${learnRuns.jobId} and ${asyncJobs.status} in ('pending', 'processing'))`;
}

/** SQL predicate: queued or running, and its job alive (or about to be). */
export function learnRunInFlight() {
    return and(
        inArray(learnRuns.status, ["queued", "running"]),
        or(
            jobAlive(),
            sql`(${learnRuns.jobId} is null and ${learnRuns.createdAt} > now() - ${JOB_GRACE})`,
        ),
    );
}

/** SQL predicate: queued or running, but its job is gone. */
export function learnRunDead() {
    return and(
        inArray(learnRuns.status, ["queued", "running"]),
        sql`not (${or(
            jobAlive(),
            sql`(${learnRuns.jobId} is null and ${learnRuns.createdAt} > now() - ${JOB_GRACE})`,
        )})`,
    );
}

/** SQL predicate: open (in flight, or ready for review). */
export function learnRunOpen() {
    return or(sql`${learnRuns.status} = 'ready'`, learnRunInFlight());
}
