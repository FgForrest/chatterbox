import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings, userSettings } from "@/db/schema";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { applyGeneratedTitle } from "@/lib/recordings/apply-generated-title";
import { titleStillGenerated } from "@/lib/recordings/generated-title";
import { emitEvent } from "@/lib/webhooks/emit";

/** Retitle a private recording from its completed summary when enabled. */
export async function updateTitleAfterSummary(input: {
    userId: string;
    recordingId: string;
    summary: string;
    keyPoints: string[];
}): Promise<void> {
    if (!input.summary.trim()) return;
    const [settings] = await db
        .select({
            syncTitleToPlaud: userSettings.syncTitleToPlaud,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, input.userId))
        .limit(1);
    const profile = await resolveItemProfile(
        input.recordingId,
        "private",
        input.userId,
    );
    const title = profile.settings.steps.title;
    if (
        !title.automatic ||
        !(await titleStillGenerated(input.userId, input.recordingId))
    ) {
        return;
    }
    const [recording] = await db
        .select({ plaudFileId: recordings.plaudFileId })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, input.recordingId),
                eq(recordings.userId, input.userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return;
    const retitled = await applyGeneratedTitle({
        userId: input.userId,
        recordingId: input.recordingId,
        text: [input.summary, ...input.keyPoints].join("\n"),
        source: "summary",
        plaudFileId: recording.plaudFileId,
        syncTitleToPlaud: settings?.syncTitleToPlaud ?? false,
    });
    if (retitled) {
        await emitEvent("recording.updated", input.userId, input.recordingId);
    }
}
