/**
 * Queueing the correction pass (`correction-pass.ts`) when a Learn run
 * finishes: in the transaction that finishes it, so the pass exists
 * exactly when the run is finished, and the title, summary and topics
 * automatic Learn held back wait for it too (`releaseAutoLearnHold`).
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import {
    bindAvailableCorrectionInTx,
    lockPipelineTargetsInTx,
} from "@/db/queries/pipeline-jobs";
import {
    asyncJobs,
    type learnRuns,
    transcriptCorrectionPasses,
    transcriptions,
} from "@/db/schema";
import { recordingJobSubject } from "@/lib/sharing/view";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const LEARN_CORRECT_JOB_KIND = "learn.correct";
export const LEARN_CORRECT_MAX_ATTEMPTS = 2;

/** Supersede correction work that belongs to an older transcript revision. */
export async function supersedeCorrectionPassesInTx(
    tx: Tx,
    userId: string,
    transcriptionId: string,
): Promise<void> {
    const [transcript] = await tx
        .select({ revision: transcriptions.revision })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.id, transcriptionId),
                eq(transcriptions.userId, userId),
            ),
        )
        .limit(1);
    if (!transcript) return;
    const passes = await tx
        .select({
            id: transcriptCorrectionPasses.id,
            itemId: transcriptCorrectionPasses.recordingId,
            actorUserId: transcriptCorrectionPasses.actorUserId,
        })
        .from(transcriptCorrectionPasses)
        .where(
            and(
                eq(transcriptCorrectionPasses.userId, userId),
                eq(transcriptCorrectionPasses.transcriptionId, transcriptionId),
                ne(
                    transcriptCorrectionPasses.transcriptRevision,
                    transcript.revision,
                ),
                inArray(transcriptCorrectionPasses.status, [
                    "queued",
                    "running",
                ]),
            ),
        );
    const passIds = passes.map((pass) => pass.id);
    if (passIds.length === 0) return;
    await lockPipelineTargetsInTx(
        tx,
        passes.map((pass) => ({ itemId: pass.itemId, userId })),
    );
    const actorUserIds = [
        ...new Set(
            passes.flatMap((pass) =>
                pass.actorUserId ? [pass.actorUserId] : [],
            ),
        ),
    ];
    const now = new Date();
    if (actorUserIds.length > 0) {
        await tx
            .update(asyncJobs)
            .set({
                status: "failed",
                completedAt: now,
                updatedAt: now,
                heartbeatAt: null,
                claimToken: null,
                lastError: "Cancelled because the transcript was rewritten",
            })
            .where(
                and(
                    inArray(asyncJobs.userId, actorUserIds),
                    eq(asyncJobs.kind, LEARN_CORRECT_JOB_KIND),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                    inArray(
                        sql<string>`${asyncJobs.payload} ->> 'passId'`,
                        passIds,
                    ),
                ),
            );
    }
    await tx
        .update(transcriptCorrectionPasses)
        .set({ status: "superseded", finishedAt: now, updatedAt: now })
        .where(
            and(
                eq(transcriptCorrectionPasses.userId, userId),
                inArray(transcriptCorrectionPasses.id, passIds),
                inArray(transcriptCorrectionPasses.status, [
                    "queued",
                    "running",
                ]),
            ),
        );
}

/**
 * Queue the correction pass after `run` finished, unless the person who
 * ran it turned it off (it is on by default) or a pass on the recording's
 * view is already queued or running. Returns whether one was queued.
 */
export async function queueCorrectionPassInTx(
    tx: Tx,
    run: Pick<
        typeof learnRuns.$inferSelect,
        | "id"
        | "userId"
        | "scopeUserId"
        | "itemId"
        | "transcriptionId"
        | "transcriptRevision"
        | "view"
        | "actorUserId"
    > & { transcriptionId: string },
    correctAfterLearn: boolean,
): Promise<boolean> {
    if (!run.actorUserId) return false;
    if (!correctAfterLearn) return false;
    await lockPipelineTargetsInTx(tx, [
        { itemId: run.itemId, userId: run.userId },
    ]);
    const [pass] = await tx
        .insert(transcriptCorrectionPasses)
        .values({
            userId: run.userId,
            scopeUserId: run.scopeUserId,
            recordingId: run.itemId,
            transcriptionId: run.transcriptionId,
            transcriptRevision: run.transcriptRevision,
            learnRunId: run.id,
            view: run.view,
            actorUserId: run.actorUserId,
        })
        .returning({ id: transcriptCorrectionPasses.id });
    if (!pass) return false;
    const queued = await enqueueJobInTx(tx, {
        userId: run.actorUserId,
        kind: LEARN_CORRECT_JOB_KIND,
        subjectId: recordingJobSubject(run.itemId, run.view),
        maxAttempts: LEARN_CORRECT_MAX_ATTEMPTS,
        payload: { passId: pass.id },
    });
    if (!queued) {
        await tx
            .delete(transcriptCorrectionPasses)
            .where(eq(transcriptCorrectionPasses.id, pass.id));
    }
    if (queued) await bindAvailableCorrectionInTx(tx, run.itemId, run.userId);
    return queued;
}
