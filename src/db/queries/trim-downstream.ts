import { and, eq, inArray, notExists, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import { asyncJobs, learnRuns } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";

/** Wake the owner's pending automatic downstream work under the processing lock. */
export async function wakeTrimDownstreamInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    userId: string,
    recordingId: string,
): Promise<void> {
    const now = new Date();
    await tx
        .update(asyncJobs)
        .set({ nextAttemptAt: now, updatedAt: now })
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(asyncJobs.status, "pending"),
                sql`${asyncJobs.payload} ->> 'trigger' is distinct from 'manual'`,
                or(
                    and(
                        inArray(asyncJobs.subjectId, [
                            recordingId,
                            `org:${recordingId}`,
                        ]),
                        inArray(asyncJobs.kind, [
                            "learn.run",
                            "learn.release",
                            "summary",
                            "topics",
                        ]),
                    ),
                    and(
                        eq(asyncJobs.kind, "pipeline.action"),
                        eq(
                            asyncJobs.subjectId,
                            `applyPlaudTasks:${recordingId}`,
                        ),
                    ),
                ),
                notExists(
                    tx
                        .select({ id: learnRuns.id })
                        .from(learnRuns)
                        .where(
                            and(
                                eq(asyncJobs.kind, "learn.run"),
                                eq(learnRuns.userId, userId),
                                eq(learnRuns.actorUserId, userId),
                                eq(learnRuns.itemId, recordingId),
                                eq(
                                    learnRuns.id,
                                    sql`${asyncJobs.payload} ->> 'runId'`,
                                ),
                                eq(learnRuns.trigger, "manual"),
                            ),
                        ),
                ),
            ),
        );
    nudge();
}
