/**
 * Queueing topic detection. Kept light for the same reason as
 * `summary-job.ts`: the route and the transcription pipeline import this;
 * only the worker registration imports the handler and its provider client.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
    countRateLimitedJobs,
    delayBehindBacklog,
    type EnqueueJobResult,
    enqueueJob,
} from "@/db/queries/async-jobs";
import { userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { nudge } from "@/lib/jobs/nudge";
import { JobDeferredError } from "@/lib/jobs/retryable";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { type RecordingView, recordingJobSubject } from "@/lib/sharing/view";
import type { TopicSource } from "./generate-topics";

export const TOPICS_JOB_KIND = "topics";

/** As summaries: a click outranks a sync's backlog. */
export const TOPICS_PRIORITY_MANUAL = 10;
export const TOPICS_PRIORITY_AUTO = 0;

export const TOPICS_MAX_ATTEMPTS = 3;

/** One request per 40k characters of transcript; ten minutes is generous. */
export const TOPICS_TIMEOUT_MS = 10 * 60 * 1000;

export interface TopicsJobPayload {
    recordingId: string;
    source: TopicSource;
    trigger: "manual" | "auto";
    /** Absent on the private view, which is every job queued before views. */
    view?: RecordingView;
    /** Put off by the hourly cap: it passes the cap when it starts. */
    rateLimited?: true;
}

export function parseTopicsJobPayload(
    raw: Record<string, unknown>,
): TopicsJobPayload {
    const recordingId = raw.recordingId;
    if (typeof recordingId !== "string" || recordingId.length === 0) {
        throw new InvalidJobPayloadError(
            TOPICS_JOB_KIND,
            "recordingId must be a non-empty string",
        );
    }
    if (raw.source !== "plaud" && raw.source !== "riffado") {
        throw new InvalidJobPayloadError(
            TOPICS_JOB_KIND,
            'source must be "plaud" or "riffado"',
        );
    }
    if (
        raw.view !== undefined &&
        raw.view !== "org" &&
        raw.view !== "private"
    ) {
        throw new InvalidJobPayloadError(
            TOPICS_JOB_KIND,
            'view must be "private" or "org" when present',
        );
    }
    return {
        recordingId,
        source: raw.source,
        trigger: raw.trigger === "manual" ? "manual" : "auto",
        ...(raw.view === "org" ? { view: "org" as const } : {}),
        ...(raw.rateLimited === true ? { rateLimited: true as const } : {}),
    };
}

/**
 * Queue topic detection for one transcript of a recording, or return the
 * job already queued for the recording.
 *
 * The dedupe is per recording, not per transcript: a click on the Plaud
 * transcript while its Custom transcript is being processed returns that
 * job. The route compares the payload's source and says so rather than
 * reporting the other transcript's topics.
 */
export async function enqueueTopicsJob(input: {
    /** The actor. On the private view, the recording's owner. */
    userId: string;
    recordingId: string;
    source: TopicSource;
    trigger: "manual" | "auto";
    view?: RecordingView;
    /** Not before this many ms from now (a rate limit's window). */
    delayMs?: number;
    /** Put off by the hourly cap; it passes the cap when it starts. */
    rateLimited?: boolean;
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        ...(input.delayMs ? { delayMs: input.delayMs } : {}),
        // A click starts what a rate limit put off, not wait for it; the
        // same transcript's only (the job is per recording).
        ...(input.trigger === "manual"
            ? { takeOverDelayed: { payload: { source: input.source } } }
            : {}),
        userId: input.userId,
        kind: TOPICS_JOB_KIND,
        subjectId: recordingJobSubject(
            input.recordingId,
            input.view ?? "private",
        ),
        priority:
            input.trigger === "manual"
                ? TOPICS_PRIORITY_MANUAL
                : TOPICS_PRIORITY_AUTO,
        maxAttempts: TOPICS_MAX_ATTEMPTS,
        payload: {
            recordingId: input.recordingId,
            source: input.source,
            trigger: input.trigger,
            ...(input.view === "org" ? { view: "org" } : {}),
            ...(input.rateLimited ? { rateLimited: true } : {}),
        },
    });
    if (enqueued.created) nudge();
    return enqueued;
}

/**
 * Automatic topics the hourly cap put off, about to start: they count
 * against the cap now, or wait for the next window (`JobDeferredError`).
 */
export async function admitRateLimitedAutoTopics(
    userId: string,
): Promise<void> {
    const rateLimit = await consumeRateLimitBucket(
        `auto-topics:user:${userId}`,
        {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        },
    );
    if (!rateLimit.allowed) {
        throw new JobDeferredError(
            Math.max(1_000, rateLimit.resetAt.getTime() - Date.now()),
            "The hourly cap on automatic topics is still full",
        );
    }
}

/**
 * Queue topics after a transcript with timings was written, when the user
 * asked for that. Never throws: the transcript is what matters to whoever
 * wrote it, and topics can always be detected by hand. `strict` (a job
 * that retries until what it queues is queued) throws a failure to queue.
 */
export async function queueAutoTopics(
    userId: string,
    recordingId: string,
    source: TopicSource,
    { strict = false }: { strict?: boolean } = {},
): Promise<void> {
    try {
        const [settings] = await db
            .select({ autoDetectTopics: userSettings.autoDetectTopics })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        if (!settings?.autoDetectTopics) return;

        // Same ceiling as auto-summary, in its own bucket: a sync replaying
        // many recordings must not run up a provider bill unattended.
        const window = {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        };
        // Behind a backlog the cap put off, in turn (see queueAutoSummary).
        const backlog = await countRateLimitedJobs(userId, TOPICS_JOB_KIND);
        let putOff: number | null = null;
        if (backlog > 0) {
            putOff = delayBehindBacklog({
                ...window,
                resetAt: new Date(),
                backlog,
            });
        } else {
            const rateLimit = await consumeRateLimitBucket(
                `auto-topics:user:${userId}`,
                window,
            );
            if (!rateLimit.allowed && !strict) {
                console.warn(
                    `Auto-topics rate limit hit for user ${userId} (recording ${recordingId})`,
                );
                return;
            }
            // Strict (what was held for Learn): queued for when the window
            // opens again, not dropped.
            if (!rateLimit.allowed) {
                putOff = delayBehindBacklog({
                    ...window,
                    resetAt: rateLimit.resetAt,
                    backlog,
                });
            }
        }
        await enqueueTopicsJob({
            userId,
            recordingId,
            source,
            trigger: "auto",
            ...(putOff === null ? {} : { rateLimited: true, delayMs: putOff }),
        });
    } catch (error) {
        if (strict) throw error;
        console.error(
            `Could not queue topics for recording ${recordingId}:`,
            error,
        );
    }
}
