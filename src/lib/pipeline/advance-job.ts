import { db } from "@/db";
import { completeProcessingGenerationInTx } from "@/db/queries/pipeline";
import { JobDeferredError } from "@/lib/jobs/retryable";
import { InvalidJobPayloadError, type JobHandler } from "@/lib/jobs/types";
import { executePipelineAction } from "@/lib/pipeline/execute";
import { gatherFacts } from "@/lib/pipeline/facts";
import type { PipelineJobResult } from "@/lib/pipeline/outcome";
import { isProviderBlockedReason, planAdvance } from "@/lib/pipeline/plan";
import { sweepAutomaticTranscriptionRetries } from "@/lib/pipeline/sweep";
import { PIPELINE_ADVANCE_JOB_KIND } from "@/lib/pipeline/trigger";
import type { PipelineView } from "@/lib/pipeline/types";

const MAX_STABLE_CHECKS = 10;
const UNSTABLE_RETRY_MS = 5_000;

export interface PipelineAdvancePayload {
    itemId: string;
    view: PipelineView;
    reason?: string;
}

async function advancePipeline(
    userId: string,
    payload: PipelineAdvancePayload,
    signal: AbortSignal,
): Promise<PipelineJobResult> {
    for (let iteration = 0; iteration < MAX_STABLE_CHECKS; iteration++) {
        const facts = await gatherFacts(payload.itemId, payload.view, userId, {
            legacyIfEmpty: payload.reason !== "arrival",
        });
        const transcribe = facts.phases.transcribe;
        if (
            payload.view === "private" &&
            transcribe?.state === "failed" &&
            transcribe.automatic &&
            isProviderBlockedReason(transcribe.reason) &&
            (await sweepAutomaticTranscriptionRetries(1, {
                userId,
                itemId: payload.itemId,
            })) > 0
        )
            continue;
        const generation = facts.generation;
        const plan = planAdvance(facts);
        for (const action of plan.actions) {
            signal.throwIfAborted();
            await executePipelineAction({
                action,
                itemId: payload.itemId,
                userId,
                view: payload.view,
                generation,
            });
        }
        signal.throwIfAborted();
        const completed = await db.transaction((tx) =>
            completeProcessingGenerationInTx(
                tx,
                payload.itemId,
                payload.view,
                userId,
                generation,
            ),
        );
        if (completed === "missing")
            return {
                skipped: "gone",
                outcome: { kind: "skipped", reason: "gone" },
            };
        if (completed === "stable") {
            return {
                processedGeneration: generation,
                outcome: { kind: "done" },
            };
        }
    }
    throw new JobDeferredError(
        UNSTABLE_RETRY_MS,
        "Pipeline requests kept changing while the driver ran",
    );
}

export const pipelineAdvanceJobHandler: JobHandler<PipelineAdvancePayload> = {
    kind: PIPELINE_ADVANCE_JOB_KIND,
    concurrency: 2,
    maxAttempts: 10,
    timeoutMs: 60_000,
    backoff: { baseMs: 10_000, maxMs: 5 * 60_000, jitter: 0.3 },
    parsePayload(raw) {
        if (typeof raw.itemId !== "string" || !raw.itemId) {
            throw new InvalidJobPayloadError(
                PIPELINE_ADVANCE_JOB_KIND,
                "itemId",
            );
        }
        if (raw.view !== "private" && raw.view !== "org") {
            throw new InvalidJobPayloadError(
                PIPELINE_ADVANCE_JOB_KIND,
                'view must be "private" or "org"',
            );
        }
        return {
            itemId: raw.itemId,
            view: raw.view,
            ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        };
    },
    run: ({ userId, payload, signal }) =>
        advancePipeline(userId, payload, signal),
};
