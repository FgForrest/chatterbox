// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import { WorkflowStrip } from "@/components/pipeline/workflow-indicator";
import type { ProcessingStep } from "@/lib/pipeline/processing-status";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () =>
        (
            value: string | { message: string },
            params?: Record<string, unknown>,
        ) => {
            const message = typeof value === "string" ? value : value.message;
            return message.replace(/\{(\w+)\}/g, (_, key: string) =>
                String(params?.[key] ?? ""),
            );
        },
}));
vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));

function data() {
    return processingFixture({
        itemId: "item-card-veln",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: {
                state: "done",
                generation: 1,
                at: new Date().toISOString(),
            },
        },
        profile: null,
        placements: [],
        intents: [],
        outputs: { transcript: true, learn: false, summary: false },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 1,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    });
}
beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe("#221 processing card", () => {
    it.each([
        [
            {
                state: "running",
                reason: "started",
                waitingFor: { kind: "job", status: "running" },
                actions: [],
            },
            "Learn is reading the transcript with your Almanac.",
        ],
        [
            {
                state: "queued",
                reason: "started",
                waitingFor: { kind: "job", status: "queued", position: 3 },
                actions: [],
            },
            "Queued, position 3",
        ],
        [
            {
                state: "stalled",
                reason: "started",
                waitingFor: { kind: "job", status: "running" },
                actions: [],
            },
            "Processing stalled, recovering",
        ],
        [
            {
                state: "waiting",
                reason: "review_pending",
                waitingFor: {
                    kind: "learnReview",
                    until: "2026-10-24T09:30:00Z",
                },
                actions: ["reviewLearn"],
            },
            /^Waiting for Learn review, until /,
        ],
        [
            {
                state: "waiting",
                reason: "org_unavailable",
                waitingFor: { kind: "organization" },
                actions: [],
            },
            "Waiting for the Organization to become available",
        ],
        [
            {
                state: "failed",
                reason: "lost",
                waitingFor: null,
                actions: ["retry"],
            },
            "Processing was interrupted",
        ],
        [
            {
                state: "failed",
                reason: "PROVIDER_FAILED",
                waitingFor: null,
                actions: ["retry"],
            },
            "The provider rejected the request. Check the provider and model in Settings, then try again.",
        ],
    ] satisfies [
        ProcessingStep,
        string | RegExp,
    ][])("renders the server's %s state", (step, copy) => {
        const initial = data();
        initial.steps.learn = step;
        render(
            <WorkflowStrip workflow={deriveWorkflowStatus(initial, "audio")} />,
        );
        expect(screen.getByText(copy)).toBeTruthy();
        if (step.state === "stalled")
            expect(document.querySelector(".animate-spin")).toBeNull();
        if (step.actions.some((action: string) => action === "retry"))
            expect(
                screen.getByRole("button", { name: "Try again" }),
            ).toBeTruthy();
    });
    it("shows the stale line after two failures and the retry button clears it on success", async () => {
        const initial = data();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response("", { status: 503 }))
            .mockRejectedValueOnce(new Error("offline"))
            .mockImplementation(async () =>
                Response.json({
                    processing: {
                        ...initial,
                        nextCheckAt: new Date(
                            Date.now() + 60_000,
                        ).toISOString(),
                    },
                }),
            );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <ItemWorkflow
                itemId={initial.itemId}
                kind="audio"
                initialData={initial}
                folders={[]}
                folderAssignments={[]}
                onSelectFolder={vi.fn()}
                onAddToFolder={vi.fn()}
                onRemoveFromFolder={vi.fn()}
            />,
        );
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        expect(screen.queryByText("Status may be out of date")).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(screen.getByText(/Status may be out of date/)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        });
        expect(screen.queryByText(/Status may be out of date/)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});
