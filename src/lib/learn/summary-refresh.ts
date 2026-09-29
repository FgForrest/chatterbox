/**
 * After the corrections a model reads changed outside a transcription (a
 * finished review, an undo), the summary made from the old reading is
 * stale (Task 5.6). With auto-summarize on it is made again, as after a
 * transcription (same hourly cap); with it off, the summary says it may be
 * stale (`stale` on its GET). A summary made before corrections existed
 * (no fingerprint) is left alone, as is the Organization view, which is
 * never summarized automatically.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { llmRendering } from "@/lib/learn/llm-input";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import type { RecordingView } from "@/lib/sharing/view";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";

/**
 * Whether the recording's summary was made from a reading of its
 * transcript that differs from today's: its corrections changed, or, once
 * it is shared, the Organization reads other corrections than the owner
 * did. False for a summary made before corrections existed.
 */
export async function isSummaryStale(
    ownerUserId: string,
    recordingId: string,
): Promise<boolean> {
    const [summary] = await db
        .select({
            transcriptionId: aiEnhancements.transcriptionId,
            inputFingerprint: aiEnhancements.inputFingerprint,
        })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, ownerUserId),
                eq(aiEnhancements.source, "riffado"),
            ),
        )
        .limit(1);
    if (!summary?.inputFingerprint || !summary.transcriptionId) return false;
    const current = await llmRendering(summary.transcriptionId);
    return current !== null && current.fingerprint !== summary.inputFingerprint;
}

export async function refreshSummaryAfterCorrections(input: {
    ownerUserId: string;
    recordingId: string;
    view: RecordingView;
}): Promise<void> {
    if (input.view !== "private") return;
    if (!(await isSummaryStale(input.ownerUserId, input.recordingId))) return;
    const [settings] = await db
        .select({
            autoSummarize: userSettings.autoSummarize,
            preset: userSettings.autoSummarizePreset,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, input.ownerUserId))
        .limit(1);
    if (!settings?.autoSummarize) return;
    const allowed = await consumeRateLimitBucket(
        `auto-summary:user:${input.ownerUserId}`,
        {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        },
    );
    // Over the cap: the summary says it may be stale instead.
    if (!allowed.allowed) return;
    await enqueueSummaryJob({
        userId: input.ownerUserId,
        recordingId: input.recordingId,
        presetId: settings.preset ?? undefined,
        trigger: "auto",
    });
}
