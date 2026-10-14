import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import { chatterItems, recordings, userSettings } from "@/db/schema";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { isHeldForLearn } from "@/lib/learn/hold";
import { applyGeneratedTitle } from "@/lib/recordings/apply-generated-title";
import { readTitleInput } from "@/lib/recordings/title-input";
import {
    parseTitleJobPayload,
    TITLE_JOB_KIND,
    type TitleJobPayload,
} from "@/lib/recordings/title-job";
import { emitEvent } from "@/lib/webhooks/emit";

/**
 * Generate the title automatic Learn held back, preferring a completed
 * summary to the corrected transcript, and emit `recording.updated`.
 */
export const titleJobHandler: JobHandler<TitleJobPayload> = {
    kind: TITLE_JOB_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 5 * 60 * 1000,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseTitleJobPayload,

    async run({ userId, payload }): Promise<JobResult> {
        // A newer transcript is held for Learn: its release titles it.
        if (await isHeldForLearn(payload.recordingId)) {
            return { skipped: "held" };
        }
        const [recording] = await db
            .select({
                plaudFileId: recordings.plaudFileId,
                titleEditedAt: chatterItems.titleEditedAt,
            })
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.id, payload.recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);
        if (!recording) return { skipped: "gone" };
        if (recording.titleEditedAt) return { skipped: "manual title" };
        const [settings] = await db
            .select({
                autoGenerateTitle: userSettings.autoGenerateTitle,
                syncTitleToPlaud: userSettings.syncTitleToPlaud,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        // Turned off while it waited.
        if (settings && !settings.autoGenerateTitle) {
            return { skipped: "off" };
        }
        const input = await readTitleInput(userId, payload.recordingId);
        if (!input) return { skipped: "no title input" };
        const retitled = await applyGeneratedTitle({
            userId,
            recordingId: payload.recordingId,
            ...input,
            plaudFileId: recording.plaudFileId,
            syncTitleToPlaud: settings?.syncTitleToPlaud ?? false,
        });
        if (retitled) {
            await emitEvent("recording.updated", userId, payload.recordingId);
        }
        return { retitled };
    },
};
