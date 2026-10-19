import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, recordings, userSettings } from "@/db/schema";
import {
    markAutomaticTitleSkipped,
    readProcessing,
} from "@/lib/pipeline/state";
import { automaticTitleSettled } from "@/lib/pipeline/title-step";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { applyGeneratedTitle } from "@/lib/recordings/apply-generated-title";
import type { TitleInputFence } from "@/lib/recordings/title-input";
import { emitEvent } from "@/lib/webhooks/emit";

/** Generate the one automatic title from an item's first completed summary. */
export async function updateTitleAfterSummary(input: {
    userId: string;
    recordingId: string;
    summary: string;
    keyPoints: string[];
    fence?: TitleInputFence;
}): Promise<void> {
    const processing = await readProcessing(
        input.recordingId,
        "private",
        input.userId,
    );
    if (processing && automaticTitleSettled(processing.phases)) return;
    const profile = await resolveItemProfile(
        input.recordingId,
        "private",
        input.userId,
    );
    const title = profile.settings.steps.title;
    const fenceInput = input.fence ?? processing?.phases.summary?.inputs;
    const fence = fenceInput
        ? {
              ...fenceInput,
              profileRevisionId: profile.assigned ? profile.revisionId : null,
          }
        : undefined;
    const settleSkipped = async (
        reason:
            | "first_summary_title_disabled"
            | "first_summary_title_edited"
            | "first_summary_title_failed",
    ) => {
        if (!fence) return;
        await markAutomaticTitleSkipped({
            itemId: input.recordingId,
            userId: input.userId,
            content: fence,
            reason,
        });
    };
    if (!title.automatic) {
        await settleSkipped("first_summary_title_disabled");
        return;
    }
    const [item] = await db
        .select({
            kind: chatterItems.kind,
            titleEditedAt: chatterItems.titleEditedAt,
            plaudFileId: recordings.plaudFileId,
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
                eq(chatterItems.id, input.recordingId),
                eq(chatterItems.userId, input.userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return;
    if (item.titleEditedAt) {
        await settleSkipped("first_summary_title_edited");
        return;
    }
    const [settings] =
        item.kind === "audio"
            ? await db
                  .select({
                      syncTitleToPlaud: userSettings.syncTitleToPlaud,
                  })
                  .from(userSettings)
                  .where(eq(userSettings.userId, input.userId))
                  .limit(1)
            : [];
    let retitled: boolean;
    try {
        retitled = await applyGeneratedTitle({
            userId: input.userId,
            recordingId: input.recordingId,
            text: [input.summary, ...input.keyPoints].join("\n"),
            source: "summary",
            kind: item.kind,
            plaudFileId: item.plaudFileId ?? undefined,
            syncTitleToPlaud: settings?.syncTitleToPlaud ?? false,
            ...(fence ? { fence } : {}),
            skipIfAutomaticTitleSettled: true,
        });
    } catch (error) {
        await settleSkipped("first_summary_title_failed");
        throw error;
    }
    if (retitled) {
        await emitEvent("recording.updated", input.userId, input.recordingId);
    } else {
        await settleSkipped("first_summary_title_failed");
    }
}
