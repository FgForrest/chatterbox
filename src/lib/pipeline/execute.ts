import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { itemProcessing } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { JobDeferredError } from "@/lib/jobs/retryable";
import {
    releaseAutoLearnHold,
    startAutomaticLearn,
} from "@/lib/learn/auto-learn";
import { autoLearnMail } from "@/lib/mail/auto-process";
import { enqueuePipelineAction } from "@/lib/pipeline/action-job";
import { updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import type { PipelineAction, PipelineView } from "@/lib/pipeline/types";
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
        case "startAutoLearn": {
            const outcome =
                action.source === "mail"
                    ? await autoLearnMail(userId, itemId)
                    : await startAutomaticLearn({
                          userId,
                          itemId,
                          source: action.source,
                          timed: true,
                      });
            if (outcome.status === "started") return;
            if (outcome.status === "deferred") {
                throw new JobDeferredError(
                    outcome.delayMs,
                    "The hourly cap on automatic Learn is full",
                );
            }
            const requested = await db.transaction(async (tx) => {
                await updatePhaseInTx(tx, itemId, view, userId, "learn", {
                    state: "skipped",
                    reason: outcome.reason,
                    generation,
                    inputs: action.input,
                    at: new Date().toISOString(),
                });
                return requestAdvanceInTx(tx, {
                    itemId,
                    userId,
                    view,
                    reason: "learn-settled",
                });
            });
            if (requested) nudge();
            return;
        }
        case "releaseLearnHold":
            await releaseAutoLearnHold(itemId);
            return;
        case "releaseLearnTimeout":
            await releaseAutoLearnHold(itemId, { expired: true });
            return;
        case "executeShares":
        case "applyPlaudTasks":
            await enqueuePipelineAction(userId, itemId, action);
            return;
        case "completeCategorization": {
            const requested = await db.transaction(async (tx) => {
                const [current] = await tx
                    .select({
                        profileId: itemProcessing.profileId,
                        profileRevisionId: itemProcessing.profileRevisionId,
                        manualOnly: itemProcessing.manualOnly,
                        requestedGeneration: itemProcessing.requestedGeneration,
                    })
                    .from(itemProcessing)
                    .where(
                        and(
                            eq(itemProcessing.itemId, itemId),
                            eq(itemProcessing.userId, userId),
                            eq(itemProcessing.view, view),
                        ),
                    )
                    .limit(1)
                    .for("update");
                if (!current) return null;
                if (current.requestedGeneration !== generation) return null;
                if (!current.profileId || !current.profileRevisionId) {
                    await tx
                        .update(itemProcessing)
                        .set({
                            profileId: action.profileId,
                            profileRevisionId: action.profileRevisionId,
                            manualOnly: action.manualOnly,
                            updatedAt: new Date(),
                        })
                        .where(
                            and(
                                eq(itemProcessing.itemId, itemId),
                                eq(itemProcessing.userId, userId),
                                eq(itemProcessing.view, view),
                            ),
                        );
                }
                const advance = await requestAdvanceInTx(tx, {
                    itemId,
                    userId,
                    view,
                    reason: "categorized",
                });
                if (!advance) return null;
                await updatePhaseInTx(tx, itemId, view, userId, "categorize", {
                    state: "done",
                    reason: "categorized",
                    profileChoice: "placement",
                    generation: advance.requestedGeneration,
                    at: new Date().toISOString(),
                });
                return advance;
            });
            if (requested) nudge();
            return;
        }
        case "markPhase":
            await db.transaction((tx) =>
                updatePhaseInTx(tx, itemId, view, userId, action.phase, {
                    ...action.record,
                    generation,
                }),
            );
    }
}
