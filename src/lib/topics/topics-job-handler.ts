/**
 * Running queued topic detection. The topics are written onto the
 * transcript row, encrypted, by `generateTopicsForTranscript`; the job's
 * result carries only counts and provenance, because the job row is not
 * encrypted.
 */

import { AppError, ErrorCode } from "@/lib/errors";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { isHeldForLearn } from "@/lib/learn/hold";
import { generateTopicsForTranscript } from "./generate-topics";
import {
    parseTopicsJobPayload,
    TOPICS_JOB_KIND,
    TOPICS_MAX_ATTEMPTS,
    TOPICS_TIMEOUT_MS,
    type TopicsJobPayload,
} from "./topics-job";

export const topicsJobHandler: JobHandler<TopicsJobPayload> = {
    kind: TOPICS_JOB_KIND,
    // One at a time, like summaries: both go to the same provider.
    concurrency: 1,
    maxAttempts: TOPICS_MAX_ATTEMPTS,
    timeoutMs: TOPICS_TIMEOUT_MS,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseTopicsJobPayload,

    async run({ payload, userId, reportProgress }): Promise<JobResult> {
        // As for automatic summaries: the hold's release detects them. It
        // holds the Riffado transcript's; the Plaud one's go on.
        if (
            payload.trigger !== "manual" &&
            payload.view !== "org" &&
            payload.source === "riffado" &&
            (await isHeldForLearn(payload.recordingId))
        ) {
            return { skipped: "held" };
        }
        let result: Awaited<ReturnType<typeof generateTopicsForTranscript>>;
        try {
            result = await generateTopicsForTranscript(
                userId,
                payload.recordingId,
                payload.source,
                {
                    trigger: payload.trigger,
                    onProgress: reportProgress,
                    view: payload.view,
                },
            );
        } catch (error) {
            // Shared since it was queued: an automatic run has nothing to
            // do, and nothing failed. A person who asked is told why.
            if (
                error instanceof AppError &&
                error.code === ErrorCode.RECORDING_SHARED &&
                payload.trigger !== "manual"
            ) {
                return { skipped: "shared" };
            }
            throw error;
        }
        return {
            source: payload.source,
            topicCount: result.topics.length,
            provider: result.provider,
            model: result.model,
            templateId: result.templateId,
            windows: result.windows,
        };
    },
};
