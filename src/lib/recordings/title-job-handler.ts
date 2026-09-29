import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions, userSettings } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { applyGeneratedTitle } from "@/lib/recordings/apply-generated-title";
import {
    parseTitleJobPayload,
    TITLE_JOB_KIND,
    type TitleJobPayload,
} from "@/lib/recordings/title-job";
import { emitEvent } from "@/lib/webhooks/emit";

/**
 * Generate the title automatic Learn held back, from the transcript as it
 * reads now, and say so with `recording.updated` when it renamed it.
 */
export const titleJobHandler: JobHandler<TitleJobPayload> = {
    kind: TITLE_JOB_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 5 * 60 * 1000,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseTitleJobPayload,

    async run({ userId, payload }): Promise<JobResult> {
        const [recording] = await db
            .select({ plaudFileId: recordings.plaudFileId })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, payload.recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);
        if (!recording) return { skipped: "gone" };
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
        const [transcript] = await db
            .select({ text: transcriptions.text })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, payload.recordingId),
                    eq(transcriptions.userId, userId),
                    eq(transcriptions.source, "riffado"),
                ),
            )
            .limit(1);
        if (!transcript?.text) return { skipped: "no transcript" };
        const retitled = await applyGeneratedTitle({
            userId,
            recordingId: payload.recordingId,
            text: decryptText(transcript.text),
            plaudFileId: recording.plaudFileId,
            syncTitleToPlaud: settings?.syncTitleToPlaud ?? false,
        });
        if (retitled) {
            await emitEvent("recording.updated", userId, payload.recordingId);
        }
        return { retitled };
    },
};
