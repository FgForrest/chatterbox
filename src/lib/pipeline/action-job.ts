import { enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError, type JobHandler } from "@/lib/jobs/types";
import {
    type PipelineJobResult,
    type StepOutcome,
    waitForReason,
} from "@/lib/pipeline/outcome";
import { executeIntendedSharesWithOutcome } from "@/lib/pipeline/share-intent";
import type { PipelineAction } from "@/lib/pipeline/types";
import { applyPlaudActionItemProposals } from "@/lib/tasks/plaud-proposals";

type Action = Extract<
    PipelineAction,
    { type: "executeShares" | "applyPlaudTasks" }
>;
interface ActionPayload {
    itemId: string;
    action: Action;
}

export const PIPELINE_ACTION_JOB_KIND = "pipeline.action";

/** Queue a content or sharing action together with its step binding. */
export async function enqueuePipelineAction(
    userId: string,
    itemId: string,
    action: Action,
): Promise<void> {
    await enqueueJob({
        userId,
        kind: PIPELINE_ACTION_JOB_KIND,
        subjectId: `${action.type}:${itemId}`,
        maxAttempts: 3,
        payload: { itemId, action },
        pipeline:
            action.type === "executeShares"
                ? { itemId, userId, phase: "share" }
                : {
                      itemId,
                      userId,
                      phase: "summary",
                      step: "summary",
                      record: action.record,
                  },
    });
    nudge();
}

export const pipelineActionJobHandler: JobHandler<ActionPayload> = {
    kind: PIPELINE_ACTION_JOB_KIND,
    concurrency: 2,
    maxAttempts: 3,
    timeoutMs: 60_000,
    parsePayload(raw) {
        if (
            typeof raw.itemId !== "string" ||
            !raw.itemId ||
            !raw.action ||
            typeof raw.action !== "object" ||
            !("type" in raw.action) ||
            !["executeShares", "applyPlaudTasks"].includes(
                String(raw.action.type),
            )
        )
            throw new InvalidJobPayloadError(
                PIPELINE_ACTION_JOB_KIND,
                "action",
            );
        return { itemId: raw.itemId, action: raw.action as Action };
    },
    async run({ userId, payload }): Promise<PipelineJobResult> {
        if (payload.action.type === "applyPlaudTasks") {
            const applied = await applyPlaudActionItemProposals({
                itemId: payload.itemId,
                userId,
                view: "private",
                expectedFingerprint: payload.action.sourceFingerprint,
                record: payload.action.record,
                settle: false,
            });
            return {
                outcome: applied
                    ? { kind: "done", reason: "plaud_tasks" }
                    : { kind: "skipped", reason: "outdated" },
            };
        }
        const result = await executeIntendedSharesWithOutcome(
            userId,
            payload.itemId,
        );
        const reason = result.confirmationRequired
            ? "confirmation_required"
            : result.problems.length > 0
              ? "gate_blocked"
              : result.remaining
                ? "org_unavailable"
                : undefined;
        const outcome: StepOutcome = reason
            ? {
                  kind: "waiting",
                  reason,
                  waitingFor: waitForReason(reason),
                  problems: result.problems,
              }
            : result.shared
              ? { kind: "done", reason: "shared" }
              : { kind: "skipped", reason: "cancelled" };
        return { outcome };
    },
};
