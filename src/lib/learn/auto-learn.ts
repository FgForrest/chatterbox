/**
 * Automatic Learn and what waits for it (Task 5.5).
 *
 * With automatic Learn on, a transcript with timings starts a Learn run by
 * itself, and the recording's title, summary and topics are held back
 * (`recordings.summaryDueAt`) so they are made from the transcript as the
 * person's review corrects it. The hold is released, once, when:
 * - no Learn run on the recording's private view is open (`learnRunOpen`:
 *   ready for review, or queued or running with its job alive): the review
 *   finished, the run found nothing, failed, died, or was cancelled or
 *   superseded with no successor; or
 * - `summaryDueAt` passed (72 h): nobody reviewed, and the rest goes on
 *   without them.
 * A new Riffado transcript clears the hold in the transaction that writes
 * it (`transcriptRewrittenInTx`): that transcription makes its own title,
 * summary and topics, or holds them again. Erasing the transcript or
 * deleting the recording clears it too.
 *
 * Releasing clears the hold and queues one `learn.release` job in the same
 * transaction, so what waited is never lost to a crash between the two;
 * that job queues the title job, topics and the automatic summary as the
 * person's settings ask then, retried until it has. The jobs it queues
 * check again that no newer hold began (`isHeldForLearn`). With automatic
 * Learn off, nothing here runs: the title follows the transcription.
 */

import { and, eq, isNotNull, isNull, lte, notExists } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    learnRuns,
    recordings,
    userSettings,
} from "@/db/schema";
import { env } from "@/lib/env";
import { nudge } from "@/lib/jobs/nudge";
import {
    InvalidJobPayloadError,
    type JobHandler,
    type JobResult,
} from "@/lib/jobs/types";
import {
    isAutoLearnOffered,
    isLearnAvailableFor,
} from "@/lib/knowledge/availability";
import { settleDeadLearnRuns, startLearnRun } from "@/lib/learn/learn-job";
import { learnRunOpen } from "@/lib/learn/learn-open";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { enqueueTitleJob } from "@/lib/recordings/title-job";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import { queueAutoTopics } from "@/lib/topics/topics-job";

/** How long the title, summary and topics wait for Learn's review. */
export const AUTO_LEARN_HOLD_MS = 72 * 60 * 60 * 1000;

export const LEARN_RELEASE_JOB_KIND = "learn.release";

/**
 * After a transcript with timings was written on the private view: start
 * automatic Learn and hold the title, summary and topics back, when the
 * person asked for it and it can run. Returns whether it holds them; when
 * not, the caller makes them now, as without automatic Learn. Never throws.
 */
export async function holdForAutoLearn(input: {
    userId: string;
    recordingId: string;
    timed: boolean;
}): Promise<boolean> {
    const { userId, recordingId, timed } = input;
    try {
        if (!timed || !isAutoLearnOffered()) return false;
        const [settings] = await db
            .select({ autoLearn: userSettings.autoLearn })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        if (!settings?.autoLearn) return false;
        if (!(await isLearnAvailableFor(userId))) return false;
        const access = await resolveRecordingAccess(userId, recordingId);
        // Shared: the Organization's to change; its curator runs Learn.
        if (!access || access.role !== "owner" || access.shared) return false;
        // Same ceiling as the automatic summary, in its own bucket.
        const rateLimit = await consumeRateLimitBucket(
            `auto-learn:user:${userId}`,
            {
                limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
                windowMs: 60 * 60 * 1000,
            },
        );
        if (!rateLimit.allowed) return false;

        try {
            await startLearnRun({
                access: { ...access, view: "private", contentUserId: userId },
                actorUserId: userId,
                source: "riffado",
                trigger: "auto",
            });
        } catch (error) {
            console.error(
                `Automatic Learn could not start for recording ${recordingId}:`,
                error,
            );
            return false;
        }
        // Held once the run exists, so nothing between the two can find
        // the hold with no run to wait for. A run that settled before the
        // hold was set found no hold to release: checked here instead.
        const [held] = await db
            .update(recordings)
            .set({ summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS) })
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .returning({ id: recordings.id });
        if (!held) return false;
        await releaseAutoLearnHold(recordingId);
        return true;
    } catch (error) {
        console.error(
            `Automatic Learn skipped for recording ${recordingId}:`,
            error,
        );
        return false;
    }
}

/**
 * Release a recording's hold when no run on its private view is open
 * (`expired`: when its time is up, whatever is open). Exactly once: the
 * hold is cleared by the statement that checks it, and the release job is
 * queued in the same transaction. Returns whether it released. Never
 * throws.
 */
export async function releaseAutoLearnHold(
    recordingId: string,
    {
        expired = false,
        now = new Date(),
    }: { expired?: boolean; now?: Date } = {},
): Promise<boolean> {
    try {
        if (!expired) await settleDeadLearnRuns(recordingId);
        const open = db
            .select({ id: learnRuns.id })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.recordingId, recordingId),
                    eq(learnRuns.view, "private"),
                    learnRunOpen(),
                ),
            );
        const released = await db.transaction(async (tx) => {
            const [row] = await tx
                .update(recordings)
                .set({ summaryDueAt: null })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        isNotNull(recordings.summaryDueAt),
                        // A renewed hold is not the one whose time was up.
                        expired
                            ? lte(recordings.summaryDueAt, now)
                            : notExists(open),
                    ),
                )
                .returning({ userId: recordings.userId });
            if (!row) return false;
            await enqueueJobInTx(tx, {
                userId: row.userId,
                kind: LEARN_RELEASE_JOB_KIND,
                subjectId: recordingId,
                maxAttempts: 5,
                payload: { recordingId },
            });
            return true;
        });
        if (released) nudge();
        return released;
    } catch (error) {
        console.error(
            `Could not release what waited for Learn on recording ${recordingId}:`,
            error,
        );
        return false;
    }
}

/** What the transcription held back, as the person's settings ask now. */
async function queueReleased(
    userId: string,
    recordingId: string,
): Promise<JobResult> {
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return { skipped: "gone" };
    const [settings] = await db
        .select({
            autoGenerateTitle: userSettings.autoGenerateTitle,
            autoSummarize: userSettings.autoSummarize,
            autoSummarizePreset: userSettings.autoSummarizePreset,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const queued: string[] = [];
    // A failure here fails the job, which is retried: nothing is lost.
    if (settings?.autoGenerateTitle ?? true) {
        await enqueueTitleJob(userId, recordingId);
        queued.push("title");
    }
    await queueAutoTopics(userId, recordingId, "riffado");
    if (settings?.autoSummarize) {
        // A person who made one while it waited keeps theirs.
        const [made] = await db
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, recordingId),
                    eq(aiEnhancements.userId, userId),
                    eq(aiEnhancements.source, "riffado"),
                ),
            )
            .limit(1);
        if (!made) {
            await queueAutoSummary(
                userId,
                recordingId,
                settings.autoSummarizePreset ?? null,
            );
            queued.push("summary");
        }
    }
    return { queued };
}

export interface LearnReleasePayload {
    recordingId: string;
}

export const learnReleaseJobHandler: JobHandler<LearnReleasePayload> = {
    kind: LEARN_RELEASE_JOB_KIND,
    concurrency: 2,
    maxAttempts: 5,
    timeoutMs: 60_000,
    backoff: { baseMs: 10_000, maxMs: 5 * 60_000, jitter: 0.3 },
    parsePayload(raw) {
        if (typeof raw.recordingId !== "string" || !raw.recordingId) {
            throw new InvalidJobPayloadError(
                LEARN_RELEASE_JOB_KIND,
                "recordingId",
            );
        }
        return { recordingId: raw.recordingId };
    },
    run: ({ userId, payload }) => queueReleased(userId, payload.recordingId),
};

/** Release the holds whose time is up, a batch at a time. */
export async function sweepAutoLearnHolds(
    now = new Date(),
    limit = 50,
): Promise<number> {
    const due = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                isNotNull(recordings.summaryDueAt),
                lte(recordings.summaryDueAt, now),
            ),
        )
        .limit(limit);
    let released = 0;
    for (const { id } of due) {
        if (await releaseAutoLearnHold(id, { expired: true, now })) {
            released++;
        }
    }
    return released;
}

const SWEEP_MS = 5 * 60 * 1000;
let sweeper: ReturnType<typeof setInterval> | undefined;

/** Idempotent. The timeout is in hours; a few minutes late is fine. */
export function startAutoLearnSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => {
        void sweepAutoLearnHolds().catch((error) =>
            console.error("[auto-learn] sweep failed:", error),
        );
    }, SWEEP_MS);
    sweeper.unref?.();
}
