import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    cancelActiveJobsInTx,
    settleTerminalJobInTx,
} from "@/db/queries/async-jobs";
import {
    asyncJobs,
    chatterItems,
    itemProcessing,
    learnRuns,
    transcriptCorrectionPasses,
} from "@/db/schema";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Cancel private findings, request Learn in the shared scope, and report cancellation. */
export async function cancelPrivateLearnAtShareInTx(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
): Promise<boolean> {
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
    if (cancelled.length === 0) return false;
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
    if (!requested) return true;
    await updatePhaseInTx(tx, itemId, "private", ownerUserId, "learn", {
        state: "pending",
        reason: "scope_changed",
        generation: requested.requestedGeneration,
        at: now.toISOString(),
    });
    return true;
}

/** Cancel correction passes whose finished private review is being shared. */
export async function cancelPrivateCorrectionsAtShareInTx(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
): Promise<void> {
    const now = new Date();
    const passes = await tx
        .update(transcriptCorrectionPasses)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now })
        .where(
            and(
                eq(transcriptCorrectionPasses.recordingId, itemId),
                eq(transcriptCorrectionPasses.userId, ownerUserId),
                eq(transcriptCorrectionPasses.scopeUserId, ownerUserId),
                eq(transcriptCorrectionPasses.view, "private"),
                inArray(transcriptCorrectionPasses.status, [
                    "queued",
                    "running",
                ]),
            ),
        )
        .returning({ id: transcriptCorrectionPasses.id });
    if (passes.length === 0) return;
    const jobs = await tx
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, ownerUserId),
                eq(asyncJobs.subjectId, itemId),
                eq(asyncJobs.kind, "learn.correct"),
                inArray(asyncJobs.status, ["pending", "processing"]),
                inArray(
                    sql<string>`${asyncJobs.payload} ->> 'passId'`,
                    passes.map((pass) => pass.id),
                ),
            ),
        );
    for (const job of jobs) {
        await settleTerminalJobInTx(tx, {
            jobId: job.id,
            cancelForUserId: ownerUserId,
            status: "failed",
            code: "scope_changed",
            message:
                "Private correction pass cancelled because its review was shared",
            result: { outcome: { kind: "skipped", reason: "scope_changed" } },
        });
    }
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
