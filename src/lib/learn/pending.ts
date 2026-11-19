import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, learnRuns } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { learnRunCurrentScope } from "@/lib/learn/learn-open";
import { getOrgUserId } from "@/lib/org/config";

async function waitingFor(viewerUserId: string) {
    return and(
        eq(chatterItems.userId, viewerUserId),
        eq(learnRuns.userId, viewerUserId),
        eq(learnRuns.status, "ready"),
        isNull(chatterItems.deletedAt),
        learnRunCurrentScope(await getOrgUserId()),
    );
}

/** The viewer's items with a Learn review waiting. */
export async function recordingsNeedingReview(
    viewerUserId: string,
): Promise<Set<string>> {
    const rows = await db
        .selectDistinct({ recordingId: learnRuns.itemId })
        .from(learnRuns)
        .innerJoin(chatterItems, eq(chatterItems.id, learnRuns.itemId))
        .where(await waitingFor(viewerUserId));
    return new Set(rows.map((row) => row.recordingId));
}

/** How many of the viewer's items have a Learn review waiting. */
export async function pendingReviewCount(
    viewerUserId: string,
): Promise<number> {
    const [row] = await db
        .select({
            count: sql<number>`count(distinct ${learnRuns.itemId})::int`,
        })
        .from(learnRuns)
        .innerJoin(chatterItems, eq(chatterItems.id, learnRuns.itemId))
        .where(await waitingFor(viewerUserId));
    return row?.count ?? 0;
}

/** The viewer's pending Learn reviews, newest item first. */
export async function reviewQueue(viewerUserId: string) {
    const rows = await db
        .selectDistinct({
            id: chatterItems.id,
            filename: chatterItems.title,
            startTime: chatterItems.occurredAt,
            view: learnRuns.view,
        })
        .from(learnRuns)
        .innerJoin(chatterItems, eq(chatterItems.id, learnRuns.itemId))
        .where(await waitingFor(viewerUserId))
        .orderBy(desc(chatterItems.occurredAt));
    return rows.map((row) => ({ ...row, filename: decryptText(row.filename) }));
}
