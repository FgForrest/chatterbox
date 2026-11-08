import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import { isActive } from "@/db/queries/async-job-status";
import { asyncJobs } from "@/db/schema";
import { RECORDING_CUT_KIND } from "@/lib/recordings/cut-kind";

/** Read the owner's pending or processing cut without acquiring a lock. */
export async function readActiveCutJob(
    executor: Pick<typeof db, "select">,
    userId: string,
    recordingId: string,
) {
    const [cut] = await executor
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(asyncJobs.subjectId, recordingId),
                eq(asyncJobs.kind, RECORDING_CUT_KIND),
                isActive(),
            ),
        )
        .limit(1);
    return cut;
}
