import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, itemProcessing, transcriptions } from "@/db/schema";
import { effectiveManualOnly } from "@/lib/pipeline/effective-profile";
import {
    AssignedProfileUnavailableError,
    resolveItemProfile,
} from "@/lib/profiles/resolve";

export type PipelineQueueStep = "summary" | "topics";

/** Whether an owner-scoped pipeline driver can queue one displayed step. */
export async function pipelineMayQueue(
    userId: string,
    itemId: string,
    step: PipelineQueueStep,
): Promise<boolean> {
    const [item] = await db
        .select({
            summaryDueAt: chatterItems.summaryDueAt,
            manualOnly: itemProcessing.manualOnly,
            phases: itemProcessing.phases,
        })
        .from(chatterItems)
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, chatterItems.id),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .where(
            and(eq(chatterItems.id, itemId), eq(chatterItems.userId, userId)),
        )
        .limit(1);

    if (!item || item.summaryDueAt !== null || effectiveManualOnly(item))
        return false;
    const profile = await resolveItemProfile(itemId, "private", userId).catch(
        (error: unknown) => {
            if (error instanceof AssignedProfileUnavailableError) return null;
            throw error;
        },
    );
    if (!profile) return false;
    if (step === "summary") {
        return profile.settings.steps.summary.automatic;
    }
    if (
        !("topics" in profile.settings.steps) ||
        !profile.settings.steps.topics.automatic
    ) {
        return false;
    }

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
