import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, recordings, userSettings } from "@/db/schema";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { isHeldForLearn } from "@/lib/learn/hold";
import { markSummaryStepFailed } from "@/lib/pipeline/state";
import { resolveItemProfile } from "@/lib/profiles/resolve";
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

    async onTerminalFailure({ payload, userId, errorCode }): Promise<void> {
        await markSummaryStepFailed({
            itemId: payload.recordingId,
            userId,
            view: "private",
            step: "title",
            errorCode,
        });
    },

    async run({ userId, payload }): Promise<JobResult> {
        // A newer transcript is held for Learn: its release titles it.
        if (await isHeldForLearn(payload.recordingId)) {
            return { skipped: "held" };
        }
        const [item] = await db
            .select({
                kind: chatterItems.kind,
                plaudFileId: recordings.plaudFileId,
                titleEditedAt: chatterItems.titleEditedAt,
            })
            .from(chatterItems)
            .leftJoin(
                recordings,
                and(
                    eq(recordings.id, chatterItems.id),
                    eq(recordings.userId, chatterItems.userId),
                ),
            )
            .where(
                and(
                    eq(chatterItems.id, payload.recordingId),
                    eq(chatterItems.userId, userId),
                    isNull(chatterItems.deletedAt),
                ),
            )
            .limit(1);
        if (!item || (item.kind === "audio" && !item.plaudFileId)) {
            return { skipped: "gone" };
        }
        if (item.titleEditedAt) return { retitled: false };
        const [settings] =
            item.kind === "audio"
                ? await db
                      .select({
                          syncTitleToPlaud: userSettings.syncTitleToPlaud,
                      })
                      .from(userSettings)
                      .where(eq(userSettings.userId, userId))
                      .limit(1)
                : [];
        const profile = await resolveItemProfile(
            payload.recordingId,
            "private",
            userId,
        );
        const title = profile.settings.steps.title;
        if (!title.automatic) {
            return { skipped: "off" };
        }
        const input = await readTitleInput(userId, payload.recordingId);
        if (!input) return { skipped: "no title input" };
        if (input.fence) {
            input.fence.profileRevisionId = profile.assigned
                ? profile.revisionId
                : null;
        }
        const retitled = await applyGeneratedTitle({
            userId,
            recordingId: payload.recordingId,
            ...input,
            plaudFileId: item.plaudFileId ?? undefined,
            syncTitleToPlaud: settings?.syncTitleToPlaud ?? false,
            kind: item.kind,
        });
        if (retitled) {
            await emitEvent("recording.updated", userId, payload.recordingId);
        }
        return { retitled };
    },
};
