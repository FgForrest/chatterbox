// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStrip } from "@/components/pipeline/workflow-indicator";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (input: string | { message: string }) =>
        typeof input === "string" ? input : input.message,
}));
afterEach(cleanup);

function processing(): ItemProcessingPresentation {
    const phase = { generation: 1, at: new Date().toISOString() };
    return processingFixture({
        itemId: "recovery",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        profile: {
            id: "profile",
            name: "Notes",
            scope: "personal",
            revisionId: "revision",
            automatic: { transcribe: true, learn: true, summary: true },
        },
        phases: {
            categorize: { ...phase, state: "done" },
            transcribe: { ...phase, state: "done" },
            learn: { ...phase, state: "skipped", reason: "no_provider" },
            summary: {
                ...phase,
                state: "done",
                reason: "completed",
                steps: {
                    summary: {
                        contentId: "content",
                        contentRevision: 1,
                        generation: 1,
                        state: "skipped",
                        reason: "no_provider",
                    },
                },
            },
        },
        outputs: { transcript: true, summary: false, learn: false },
        placements: [],
        intents: [],
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    });
}

describe("workflow recovery presentation", () => {
    it.each([
        "queued",
        "running",
    ] as const)("shows an active %s transcription ahead of an old failure with no retry", (status) => {
        const data = processing();
        data.jobs.transcription = status;
        data.phases.transcribe = {
            generation: 1,
            at: new Date().toISOString(),
            state: "failed",
            reason: "NO_TRANSCRIPTION_PROVIDER",
        };
        data.failures = [
            {
                phase: "transcribe",
                reasonCode: "NO_TRANSCRIPTION_PROVIDER",
                retryAvailable: true,
            },
        ];
        const workflow = deriveWorkflowStatus(processingFixture(data), "audio");
        expect(workflow.status?.actor).toBe(
            status === "queued" ? "queued" : "working",
        );
        render(<WorkflowStrip workflow={workflow} />);
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
        expect(
            screen.getByRole("listitem", {
                name: `Transcribe, ${status === "queued" ? "Queued" : "Running"}`,
            }),
        ).toBeTruthy();
    });

    it.each([
        "no_provider",
        "no_timings",
        "hosted",
        "shared",
        "start_failed",
        "profile_off",
        "erased",
    ])("shows Summary and its Generate action after Learn skips for %s", (reason) => {
        const data = processing();
        data.phases.learn = {
            generation: 1,
            at: new Date().toISOString(),
            state: "skipped",
            reason,
        };
        expect(
            deriveWorkflowWidgets(processingFixture(data)).summary,
        ).toMatchObject({
            visible: true,
            action: "run",
            collapsed: false,
        });
        expect(
            deriveWorkflowStatus(processingFixture(data), "audio").visible,
        ).toBe(true);
    });

    it.each([
        "audio",
        "mail",
    ] as const)("offers Summarize for %s when Summary completed with only provider skips", (kind) => {
        const data = processing();
        data.phases.learn = {
            generation: 1,
            at: new Date().toISOString(),
            state: "done",
            reason: "released",
        };
        if (kind === "mail") {
            data.kind = "mail";
            delete data.phases.transcribe;
            data.outputs.transcript = false;
        }
        const workflow = deriveWorkflowStatus(processingFixture(data), kind);
        expect(workflow.visible).toBe(true);
        expect(workflow.status).toMatchObject({
            message: "manualSummary",
            action: "summarize",
        });
        expect(
            workflow.steps.find((step) => step.id === "summary"),
        ).toMatchObject({ state: "next", current: true });
        const onAction = vi.fn();
        render(<WorkflowStrip workflow={workflow} onAction={onAction} />);
        fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
        expect(onAction).toHaveBeenCalledWith("summarize");
    });

    it("keeps automatic Learn's provider skip visible even when a summary exists", () => {
        const data = processing();
        data.outputs.summary = true;
        expect(
            deriveWorkflowStatus(processingFixture(data), "audio"),
        ).toMatchObject({
            visible: true,
            status: { actor: "problem", params: { step: "learn" } },
        });
    });
});
