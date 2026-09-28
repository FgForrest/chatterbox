/**
 * Where a Learn review waits, for the lists that point at it: the
 * recordings with a run ready for review, and how many. A review is the
 * owner's on their private recordings, and the organization account's on
 * shared ones (Learn's unconfirmed suggestions are theirs alone).
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { learnRuns } from "@/db/schema";

function waitingFor(viewerUserId: string, viewerIsOrgAccount: boolean) {
    return viewerIsOrgAccount
        ? and(eq(learnRuns.view, "org"), eq(learnRuns.status, "ready"))
        : and(
              eq(learnRuns.view, "private"),
              eq(learnRuns.userId, viewerUserId),
              eq(learnRuns.status, "ready"),
          );
}

/** The recordings with a review waiting for the viewer. */
export async function recordingsNeedingReview(
    viewerUserId: string,
    viewerIsOrgAccount: boolean,
): Promise<Set<string>> {
    const rows = await db
        .selectDistinct({ recordingId: learnRuns.recordingId })
        .from(learnRuns)
        .where(waitingFor(viewerUserId, viewerIsOrgAccount));
    return new Set(rows.map((row) => row.recordingId));
}

/** How many reviews wait for the viewer. */
export async function pendingReviewCount(
    viewerUserId: string,
    viewerIsOrgAccount: boolean,
): Promise<number> {
    const [row] = await db
        .select({
            count: sql<number>`count(distinct ${learnRuns.recordingId})::int`,
        })
        .from(learnRuns)
        .where(waitingFor(viewerUserId, viewerIsOrgAccount));
    return row?.count ?? 0;
}
