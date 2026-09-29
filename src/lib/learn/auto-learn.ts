/**
 * Automatic Learn and what waits for it (Task 5.5).
 *
 * With automatic Learn on, a transcript with timings starts a Learn run by
 * itself, and the recording's title, summary and topics are held back
 * (`recordings.summaryDueAt`) so they are made from the transcript as the
 * person's review corrects it. The hold is released, once, when:
 * - no Learn run on the recording is queued, running or waiting for its
 *   review (the review finished, the run found nothing, failed, or was
 *   cancelled or superseded with no successor); or
 * - `summaryDueAt` passed (72 h): nobody reviewed, and the rest goes on
 *   without them.
 * Releasing queues the title job, topics and the automatic summary as the
 * person's settings ask then. With automatic Learn off, nothing here runs:
 * the title follows the transcription as before.
 */

import { and, eq, inArray, isNotNull, lte, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    learnRuns,
    recordings,
    userSettings,
} from "@/db/schema";
import { env } from "@/lib/env";
import {
    isAutoLearnOffered,
    isLearnAvailableFor,
} from "@/lib/knowledge/availability";
import { startLearnRun } from "@/lib/learn/learn-job";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { enqueueTitleJob } from "@/lib/recordings/title-job";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import { queueAutoTopics } from "@/lib/topics/topics-job";

/** How long the title, summary and topics wait for Learn's review. */
export const AUTO_LEARN_HOLD_MS = 72 * 60 * 60 * 1000;

/** Runs that still hold a recording back: not done, or awaiting review. */
const UNSETTLED = ["queued", "running", "ready"] as const;

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

        // Held before the run exists: a run that settles at once finds the
        // hold to release.
        await db
            .update(recordings)
            .set({ summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS) })
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            );
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
            await clearHold(recordingId);
            return false;
        }
        return true;
    } catch (error) {
        console.error(
            `Automatic Learn skipped for recording ${recordingId}:`,
            error,
        );
        await clearHold(recordingId).catch(() => undefined);
        return false;
    }
}

async function clearHold(recordingId: string): Promise<void> {
    await db
        .update(recordings)
        .set({ summaryDueAt: null })
        .where(eq(recordings.id, recordingId));
}

/**
 * Release a recording's hold when nothing holds it any more (`expired`:
 * whatever still does), and queue what waited. Exactly once: the hold is
 * cleared in the same statement that checks it. Returns whether it
 * released. Never throws.
 */
export async function releaseAutoLearnHold(
    recordingId: string,
    { expired = false }: { expired?: boolean } = {},
): Promise<boolean> {
    try {
        const unsettled = db
            .select({ id: learnRuns.id })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.recordingId, recordingId),
                    eq(learnRuns.view, "private"),
                    inArray(learnRuns.status, [...UNSETTLED]),
                ),
            );
        const [released] = await db
            .update(recordings)
            .set({ summaryDueAt: null })
            .where(
                and(
                    eq(recordings.id, recordingId),
                    isNotNull(recordings.summaryDueAt),
                    expired ? sql`true` : notExists(unsettled),
                ),
            )
            .returning({ userId: recordings.userId });
        if (!released) return false;
        await queueReleased(released.userId, recordingId);
        return true;
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
): Promise<void> {
    const [settings] = await db
        .select({
            autoGenerateTitle: userSettings.autoGenerateTitle,
            autoSummarize: userSettings.autoSummarize,
            autoSummarizePreset: userSettings.autoSummarizePreset,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    if (settings?.autoGenerateTitle ?? true) {
        await enqueueTitleJob(userId, recordingId).catch((error) =>
            console.error(
                `Could not queue the title of recording ${recordingId}:`,
                error,
            ),
        );
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
        }
    }
}

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
        if (await releaseAutoLearnHold(id, { expired: true })) released++;
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
