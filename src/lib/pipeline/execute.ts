import { db } from "@/db";
import { autoLearnMail } from "@/lib/mail/auto-process";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import type { PipelineAction, PipelineView } from "@/lib/pipeline/types";
import { enqueueTitleJob } from "@/lib/recordings/title-job";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import { queueAutoTopics } from "@/lib/topics/topics-job";
import { enqueueTranscriptionJob } from "@/lib/transcription/transcription-job";

export interface ExecutePipelineActionInput {
    action: PipelineAction;
    itemId: string;
    userId: string;
    view: PipelineView;
    generation: number;
}

/** Execute one planner action and persist marks in their own transaction. */
export async function executePipelineAction(
    input: ExecutePipelineActionInput,
): Promise<void> {
    const { action, itemId, userId, view, generation } = input;
    switch (action.type) {
        case "queueSummary":
            if (action.strict) {
                await queueAutoSummary(userId, itemId, action.presetId, {
                    strict: true,
                });
            } else {
                await queueAutoSummary(userId, itemId, action.presetId);
            }
            return;
        case "queueTopics":
            if (action.strict) {
                await queueAutoTopics(
                    userId,
                    itemId,
                    action.source ?? "riffado",
                    {
                        strict: true,
                    },
                );
            } else {
                await queueAutoTopics(
                    userId,
                    itemId,
                    action.source ?? "riffado",
                );
            }
            return;
        case "queueTranscription":
            await enqueueTranscriptionJob({
                userId,
                recordingId: itemId,
                trigger: "pipeline",
                view,
            });
            return;
        case "queueTitleJob":
            await enqueueTitleJob(userId, itemId);
            return;
        case "startAutoLearnMail":
            await autoLearnMail(userId, itemId);
            return;
        case "markPhase":
            await db.transaction((tx) =>
                updatePhaseInTx(tx, itemId, view, userId, action.phase, {
                    ...action.record,
                    generation,
                }),
            );
    }
}
