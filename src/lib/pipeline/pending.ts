import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, transcriptions, userSettings } from "@/db/schema";

export type PipelineQueueStep = "summary" | "topics";

/** Whether an owner-scoped pipeline driver can queue one displayed step. */
export async function pipelineMayQueue(
    userId: string,
    itemId: string,
    step: PipelineQueueStep,
): Promise<boolean> {
    const [[item], [settings]] = await Promise.all([
        db
            .select({ summaryDueAt: chatterItems.summaryDueAt })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, userId),
                ),
            )
            .limit(1),
        db
            .select({
                autoSummarize: userSettings.autoSummarize,
                autoDetectTopics: userSettings.autoDetectTopics,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1),
    ]);

    if (!item || item.summaryDueAt !== null) return false;
    if (step === "summary") return settings?.autoSummarize === true;
    if (!settings?.autoDetectTopics) return false;

    const [transcript] = await db
        .select({ turns: transcriptions.turns })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, itemId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, "riffado"),
            ),
        )
        .limit(1);
    return transcript !== undefined && transcript.turns !== null;
}
