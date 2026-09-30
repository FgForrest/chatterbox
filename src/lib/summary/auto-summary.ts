import {
    countRateLimitedJobs,
    delayBehindBacklog,
} from "@/db/queries/async-jobs";
import { env } from "@/lib/env";
import { JobDeferredError } from "@/lib/jobs/retryable";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { enqueueSummaryJob, SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { emitEvent } from "@/lib/webhooks/emit";

/**
 * An automatic summary the hourly cap put off, about to start: it counts
 * against the cap now, and while the cap is still full it waits for the
 * next window (`JobDeferredError`), so a released backlog never runs past
 * the cap.
 */
export async function admitRateLimitedAutoSummary(
    userId: string,
): Promise<void> {
    const rateLimit = await consumeRateLimitBucket(
        `auto-summary:user:${userId}`,
        {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        },
    );
    if (!rateLimit.allowed) {
        throw new JobDeferredError(
            Math.max(1_000, rateLimit.resetAt.getTime() - Date.now()),
            "The hourly cap on automatic summaries is still full",
        );
    }
}

/**
 * Queue the automatic summary of a recording, as auto-summarize asks after
 * a transcript: right after it, or when automatic Learn releases what it
 * held back. Never throws; a summary that could not be queued says so with
 * `summary.failed`. `strict` (a job that retries until what it queues is
 * queued) throws a failure to queue instead.
 */
export async function queueAutoSummary(
    userId: string,
    recordingId: string,
    presetId: string | null,
    { strict = false }: { strict?: boolean } = {},
): Promise<void> {
    // Per-user hourly cap on auto-summary calls. Cheap defense against
    // runaway provider cost if a sync replays N recordings or the user
    // toggles auto-summarize on with an expensive model. The manual
    // "Generate summary" button is not throttled -- the user is in the
    // loop there.
    const window = {
        limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
        windowMs: 60 * 60 * 1000,
    };
    // Queued rather than run inline. This is the unattended path -- a sync
    // can trigger a dozen of these with nobody watching -- and inline it
    // inherited the lifetime of whatever process happened to be
    // transcribing: a container upgrade partway through left a recording
    // that simply never got a summary, with nothing to say why or to try
    // again.
    //
    // `summary.completed` and `summary.failed` come from the job handler,
    // which keeps their meaning intact: the event still fires after the
    // summary is written and readable, just from the worker.
    let dropped = false;
    try {
        // A backlog the cap put off means the cap is full. Held work waits
        // behind it, in turn: fresh work taking each new window first could
        // keep that backlog waiting for ever. Its jobs pass the cap when
        // they start, oldest first.
        const backlog = await countRateLimitedJobs(userId, SUMMARY_JOB_KIND);
        let full: Date | null = backlog > 0 ? new Date() : null;
        if (!full) {
            const rateLimit = await consumeRateLimitBucket(
                `auto-summary:user:${userId}`,
                window,
            );
            if (!rateLimit.allowed) full = rateLimit.resetAt;
        }
        // What was held for Learn is queued for when the window opens
        // again, not dropped; anything else is dropped, as the cap says.
        if (full && !strict) {
            dropped = true;
        } else {
            await enqueueSummaryJob({
                userId,
                recordingId,
                presetId: presetId ?? undefined,
                trigger: "auto",
                ...(full
                    ? {
                          rateLimited: true,
                          delayMs: delayBehindBacklog({
                              ...window,
                              resetAt: full,
                              backlog,
                          }),
                      }
                    : {}),
            });
        }
    } catch (error) {
        if (strict) throw error;
        // Only a failure to QUEUE reaches here, which means the database
        // refused the backlog count, the cap or the insert -- the summary
        // itself has not been attempted yet. Never roll back the transcript over it: the user wants the
        // transcript regardless.
        console.error(
            `Could not queue auto-summary for recording ${recordingId}:`,
            error,
        );
        await emitEvent("summary.failed", userId, recordingId, {
            error: error instanceof Error ? error.message : String(error),
        });
        return;
    }
    if (dropped) {
        console.warn(
            `Auto-summary rate limit hit for user ${userId} (recording ${recordingId})`,
        );
        await emitEvent("summary.failed", userId, recordingId, {
            error: `Auto-summary rate limit exceeded (${env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR}/hour). Manual summary still works.`,
        });
    }
}
