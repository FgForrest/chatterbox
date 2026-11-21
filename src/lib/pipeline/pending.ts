import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    itemProcessing,
    recordings,
    transcriptions,
} from "@/db/schema";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";
import { effectiveManualOnly } from "@/lib/pipeline/effective-profile";
import {
    audioHasPriorOutput,
    plaudTranscriptInput,
    sharedTranscriptionReadOnly,
} from "@/lib/pipeline/transcript-facts";
import { canUsePlaudTranscript } from "@/lib/pipeline/transcript-policy";
import {
    AssignedProfileUnavailableError,
    resolveItemProfile,
} from "@/lib/profiles/resolve";
import { trimHolds } from "@/lib/recordings/trim-proposal";

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
            audioReapedAt: recordings.audioReapedAt,
            contentReapedAt: chatterItems.contentReapedAt,
            shared: sql<boolean>`${recordingSharedCondition(chatterItems.id)}`,
            hasPriorOutput: audioHasPriorOutput(db, userId, itemId),
            manualOnly: itemProcessing.manualOnly,
            phases: itemProcessing.phases,
        })
        .from(chatterItems)
        .leftJoin(
            recordings,
            and(eq(recordings.id, itemId), eq(recordings.userId, userId)),
        )
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

    if (
        !item ||
        item.summaryDueAt !== null ||
        effectiveManualOnly(item) ||
        trimHolds(item.phases?.trim)
    )
        return false;
    const profile = await resolveItemProfile(itemId, "private", userId).catch(
        (error: unknown) => {
            if (error instanceof AssignedProfileUnavailableError) return null;
            throw error;
        },
    );
    if (!profile) return false;
    const steps = profile.settings.steps;
    if (step === "summary" && !steps.summary.automatic) return false;
    if (step === "topics" && (!("topics" in steps) || !steps.topics.automatic))
        return false;
    if (!("transcribe" in steps)) return step === "summary";

    const policy = steps.transcribe;
    if (step === "summary" && policy.plaudTranscript !== "use") return true;
    const sources =
        policy.plaudTranscript === "use" ? ["riffado", "plaud"] : ["riffado"];
    const transcripts = await db
        .select({
            id: transcriptions.id,
            revision: transcriptions.revision,
            source: transcriptions.source,
            turns: transcriptions.turns,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, itemId),
                eq(transcriptions.userId, userId),
                inArray(transcriptions.source, sources),
            ),
        )
        .limit(sources.length);
    const own = transcripts.find(
        (transcript) => transcript.source === "riffado",
    );
    if (own) return step === "summary" || own.turns !== null;
    const plaud = transcripts.find(
        (transcript) => transcript.source === "plaud",
    );
    if (!plaud) return step === "summary";
    if (step === "topics" && plaud.turns === null) return false;
    return canUsePlaudTranscript({
        transcript: plaudTranscriptInput(plaud),
        policy,
        phases: item.phases ?? {},
        transcriptionBlocked:
            item.audioReapedAt != null ||
            item.contentReapedAt != null ||
            sharedTranscriptionReadOnly(item.shared),
        hasPriorOutput: item.hasPriorOutput,
    });
}
