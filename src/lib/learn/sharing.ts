import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cancelActiveJobsInTx } from "@/db/queries/async-jobs";
import { chatterItems, itemProcessing, learnRuns } from "@/db/schema";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Cancel private findings and durably request Learn in the newly shared scope. */
export async function cancelPrivateLearnAtShareInTx(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
): Promise<void> {
    const now = new Date();
    const cancelled = await tx
        .update(learnRuns)
        .set({
            status: "cancelled",
            finishedAt: now,
            updatedAt: now,
        })
        .where(
            and(
                eq(learnRuns.itemId, itemId),
                eq(learnRuns.userId, ownerUserId),
                eq(learnRuns.view, "private"),
                inArray(learnRuns.status, ["queued", "running", "ready"]),
            ),
        )
        .returning({ id: learnRuns.id });
    if (cancelled.length === 0) return;
    await cancelActiveJobsInTx(tx, {
        userId: ownerUserId,
        subjectId: itemId,
        kind: "learn.run",
        payloadValues: { key: "runId", values: cancelled.map((run) => run.id) },
        message: "Private Learn cancelled because the item was shared",
        now,
    });
    const requested = await requestAdvanceInTx(tx, {
        itemId,
        userId: ownerUserId,
        view: "private",
        reason: "learn-settled",
    });
    if (!requested) return;
    await updatePhaseInTx(tx, itemId, "private", ownerUserId, "learn", {
        state: "pending",
        reason: "scope_changed",
        generation: requested.requestedGeneration,
        at: now.toISOString(),
    });
}

/** Keep a hold while the durable pipeline is replacing a cancelled private run. */
export function learnScopeRestartPending(
    itemId: string | typeof chatterItems.id,
) {
    return db
        .select({ id: itemProcessing.itemId })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, chatterItems.userId),
                eq(itemProcessing.view, "private"),
                eq(
                    sql<string>`${itemProcessing.phases} -> 'learn' ->> 'reason'`,
                    "scope_changed",
                ),
            ),
        );
}
