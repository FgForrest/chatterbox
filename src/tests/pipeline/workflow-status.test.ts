import { describe, expect, it } from "vitest";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { PhaseRecord } from "@/lib/pipeline/types";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

const at = "2026-10-16T08:00:00.000Z";
function phase(state: PhaseRecord["state"], reason?: string): PhaseRecord {
    return { state, reason, generation: 1, at };
}
function processing(
    overrides: Partial<ItemProcessingPresentation> = {},
): ItemProcessingPresentation {
    return processingFixture({
        itemId: "item-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: phase("done", "categorized"),
            transcribe: phase("done", "transcribed"),
            learn: phase("done", "finished"),
            summary: phase("done", "finished"),
            taskReview: phase("done", "reviewed"),
        },
        profile: {
            id: "profile-1",
            name: "Meetings",
            scope: "personal",
            revisionId: "revision-1",
            automatic: { transcribe: true, learn: true, summary: true },
        },
        placements: [
            {
                id: "folder-1",
                parentId: "private",
                name: "Meetings",
                path: "Private › Meetings",
                scope: "personal",
            },
        ],
        intents: [],
        outputs: { transcript: true, learn: true, summary: true },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
        ...overrides,
    });
}

describe("server-provided workflow states", () => {
    it.each([
        ["running", "working", { kind: "job", status: "running" }],
        ["queued", "queued", { kind: "job", status: "queued", position: 3 }],
        ["stalled", "stalled", { kind: "job", status: "running" }],
        [
            "waiting",
            "review",
            { kind: "learnReview", until: "2026-10-24T09:30:00Z" },
        ],
        ["waiting", "next", { kind: "folder" }],
        ["waiting", "next", { kind: "shareConfirmation" }],
        ["waiting", "others", { kind: "organization" }],
        ["failed", "problem", null],
        ["done", "done", null],
        ["skipped", "skipped", null],
        ["pending", "waiting", { kind: "pending" }],
    ] as const)("renders %s from the response", (state, display, waitingFor) => {
        const data = processing();
        data.steps.learn = {
            state,
            reason: state === "failed" ? "lost" : "explicit",
            waitingFor,
            actions: [],
        };
        const result = deriveWorkflowStatus(data, "audio");
        expect(result.steps.find((step) => step.id === "learn")).toMatchObject({
            state: display,
            waitingFor,
        });
    });
    it("does not infer a queued step from automatic profile flags or a Learn run", () => {
        const data = processing({
            phases: { categorize: phase("done") },
            outputs: { transcript: false, learn: false, summary: false },
            latestLearnRun: {
                status: "queued",
                errorCode: null,
                updatedAt: at,
            },
        });
        data.jobs.transcription = "queued";
        expect(
            deriveWorkflowStatus(data, "audio").steps.some(
                (step) => step.state === "queued",
            ),
        ).toBe(false);
    });
    it("does not infer correction work from an empty Learn review", () => {
        const data = processing({
            phases: { learn: phase("waiting", "review_pending") },
            learnFindingsWaiting: 0,
        });
        const result = deriveWorkflowStatus(data, "audio");
        expect(result.steps.find((step) => step.id === "learn")?.state).toBe(
            "review",
        );
        expect(result.status?.action).toBeUndefined();
    });
    it("passes queue position and review deadline through", () => {
        const data = processing();
        data.steps.learn = {
            state: "queued",
            reason: "started",
            waitingFor: { kind: "job", position: 7 },
            actions: [],
        };
        expect(
            deriveWorkflowStatus(data, "audio").status?.params?.position,
        ).toBe(7);
        data.steps.learn = {
            state: "waiting",
            reason: "review_pending",
            waitingFor: { kind: "learnReview", until: at },
            actions: ["reviewLearn"],
        };
        expect(deriveWorkflowStatus(data, "audio").status).toMatchObject({
            params: { until: at },
            action: "reviewLearn",
        });
    });
    it("uses only the allowed actions", () => {
        const data = processing({ phases: { learn: phase("failed", "lost") } });
        data.steps.learn.actions = [];
        expect(
            deriveWorkflowStatus(data, "audio").status?.action,
        ).toBeUndefined();
        data.steps.learn.actions = ["retry"];
        expect(deriveWorkflowStatus(data, "audio").status?.action).toBe(
            "retry",
        );
    });
    it.each([
        ["no_provider", "failureNoProvider"],
        ["NO_TRANSCRIPTION_PROVIDER", "failureNoProvider"],
        ["AI_PROVIDER_NOT_CONFIGURED", "failureNoProvider"],
        ["PROVIDER_ERROR", "failureProvider"],
        ["PROVIDER_FAILED", "failureProvider"],
        ["AI_PROVIDER_API_ERROR", "failureProvider"],
        ["PROVIDER_TIMEOUT", "failureTimeout"],
        ["MYNAH_BUDGET_EXHAUSTED", "failureBudget"],
        ["AI_RATE_LIMITED", "failureRateLimited"],
        ["RATE_LIMITED", "failureRateLimited"],
        ["PLAUD_RATE_LIMITED", "failureRateLimited"],
        ["UPSTREAM_BAD_RESPONSE", "failureUnavailable"],
        ["SERVICE_UNAVAILABLE", "failureUnavailable"],
        ["PLAUD_UPSTREAM_ERROR", "failureUnavailable"],
        ["AI_CONTEXT_LENGTH_EXCEEDED", "failureContextTooLong"],
        ["TRANSCRIPTION_FAILED", "failureTranscription"],
        ["RECORDING_DATA_REAPED", "failureSourceUnavailable"],
        ["RECORDING_NOT_FOUND", "failureSourceUnavailable"],
        ["AUDIO_REAPED", "failureSourceUnavailable"],
        ["STORAGE_ERROR", "failureSourceUnavailable"],
        ["FORBIDDEN", "failureAccess"],
        ["RECORDING_SHARED", "failureAccess"],
        ["INTERNAL_ERROR", "stepFailed"],
        ["JOB_TERMINAL_FAILURE", "stepFailed"],
        ["UNKNOWN_FAILURE", "stepFailed"],
    ] as const)("maps failure code %s to %s", (reasonCode, message) => {
        const result = deriveWorkflowStatus(
            processing({
                phases: { summary: phase("failed", reasonCode) },
                failures: [
                    {
                        phase: "summary",
                        reasonCode,
                        retryAvailable: true,
                    },
                ],
            }),
            "audio",
        );
        expect(result.steps.find((step) => step.id === "summary")?.state).toBe(
            "problem",
        );
        expect(result.status).toEqual({
            actor: "problem",
            message,
            params: { step: "summary" },
            action: "retry",
        });
    });
});
