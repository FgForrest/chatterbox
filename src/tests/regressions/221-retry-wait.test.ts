import { describe, expect, it } from "vitest";
import {
    type ProcessingInput,
    type ProcessingQueueJob,
    projectProcessing,
} from "@/lib/pipeline/processing-status";
import type { PipelinePhases } from "@/lib/pipeline/types";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";

const now = new Date("2026-10-23T09:00:00Z");
const at = now.toISOString();
const retryAt = new Date(now.getTime() + 45_000).toISOString();
const owner = { canChange: true, canFile: true };

const cases = [
    {
        phase: "transcribe",
        kind: "transcription",
        widget: "transcript",
        job: "transcription",
    },
    { phase: "learn", kind: "learn.run", widget: "learn", job: null },
    { phase: "summary", kind: "summary", widget: "summary", job: "summary" },
] as const;

type RetryCase = (typeof cases)[number];

function project({ phase, kind }: RetryCase, jobRetryAt: string | null) {
    const phases: PipelinePhases = {
        categorize: { state: "done", reason: "filed", generation: 1, at },
    };
    if (phase === "summary")
        phases.learn = {
            state: "done",
            reason: "released",
            generation: 1,
            at,
        };
    phases[phase] = {
        state: "running",
        reason: "started",
        jobId: "job-retry-veln",
        generation: 1,
        at,
    };
    const data: ProcessingInput = {
        itemId: "item-retry-veln",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases,
        profile: null,
        placements: [],
        intents: [],
        outputs: {
            transcript: phase !== "transcribe",
            summary: false,
            learn: false,
        },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    };
    const job: ProcessingQueueJob = {
        id: "job-retry-veln",
        kind,
        status: "pending",
        stale: false,
        retryAt: jobRetryAt,
        position: 1,
        result: null,
        errorCode: null,
    };
    return projectProcessing(data, [job], owner, now);
}

describe("#221 a job waiting for its retry stays live work", () => {
    it.each(
        cases,
    )("keeps the $widget card and job state while $phase waits for a retry", (retryCase) => {
        const queued = project(retryCase, null);
        const retry = project(retryCase, retryAt);
        expect(retry.steps[retryCase.phase]).toMatchObject({
            state: "queued",
            waitingFor: { kind: "job", status: "retry", retryAt },
            actions: [],
        });
        if (retryCase.job) {
            expect(queued.jobs[retryCase.job]).toBe("queued");
            expect(retry.jobs[retryCase.job]).toBe("queued");
        }
        const widget = deriveWorkflowWidgets(retry)[retryCase.widget];
        expect(widget.visible).toBe(true);
        expect(widget.action).toBeNull();
        expect(widget).toEqual(deriveWorkflowWidgets(queued)[retryCase.widget]);
    });
    it.each(
        cases,
    )("shows the next attempt time for $phase in the strip and polls at it", (retryCase) => {
        const queued = project(retryCase, null);
        const retry = project(retryCase, retryAt);
        const workflow = deriveWorkflowStatus(retry, "audio");
        expect(
            workflow.steps.find((step) => step.id === retryCase.phase),
        ).toMatchObject({ state: "queued", current: true });
        expect(workflow.status).toEqual({
            actor: "queued",
            message: "retryScheduled",
            params: { retryAt },
        });
        expect(queued.nextCheckInMs).toBe(5_000);
        expect(retry.nextCheckInMs).toBe(45_000);
    });
});
