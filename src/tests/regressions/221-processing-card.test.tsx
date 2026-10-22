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
    it.each([
        "review_pending_timeout",
        "manual_review_pending",
    ])("renders live Learn review -> %s despite an old until", (reason) => {
        const initial = data();
        initial.steps.learn = {
            state: "waiting",
            reason: "review_pending",
            waitingFor: { kind: "learnReview", until: "2026-10-24T09:30:00Z" },
            actions: ["reviewLearn"],
        };
        const { rerender } = render(
            <WorkflowStrip workflow={deriveWorkflowStatus(initial, "audio")} />,
        );
        expect(
            screen.getByText(/^Waiting for Learn review, until /),
        ).toBeTruthy();
        initial.steps.learn.reason = reason;
        const workflow = deriveWorkflowStatus(initial, "audio");
        expect(workflow.status?.params?.until).toBeUndefined();
        if (workflow.status)
            workflow.status.params = {
                ...workflow.status.params,
                until: "2026-10-24T09:30:00Z",
            };
        rerender(<WorkflowStrip workflow={workflow} />);
        expect(
            screen.queryByText(/^Waiting for Learn review, until /),
        ).toBeNull();
        expect(
            screen.getByText(
                reason === "review_pending_timeout"
                    ? /The summary was written without your Learn review/
                    : /Review them to apply what fits/,
            ),
        ).toBeTruthy();
    });
    it("shows a scheduled attempt instead of a queue position", () => {
        const initial = data();
        initial.steps.learn = {
            state: "queued",
            reason: "started",
            waitingFor: {
                kind: "job",
                status: "retry",
                retryAt: "2026-10-24T09:30:00Z",
            },
            actions: [],
        };
        render(
            <WorkflowStrip workflow={deriveWorkflowStatus(initial, "audio")} />,
        );
        expect(screen.getByText(/^Next attempt at /)).toBeTruthy();
        expect(screen.queryByText(/^Queued, position /)).toBeNull();
    });
    it.each([
        ["share", "Sharing…"],
        ["taskReview", "Preparing task review…"],
    ] as const)("names a running %s step", (phase, copy) => {
        const initial = data();
        initial.phases[phase] = {
            state: "running",
            generation: 1,
            at: new Date().toISOString(),
        };
        if (phase === "taskReview") initial.taskReviewWaiting = 1;
        initial.steps[phase] = {
            state: "running",
            reason: "started",
            waitingFor: { kind: "job", status: "running" },
            actions: [],
        };
        render(
            <WorkflowStrip workflow={deriveWorkflowStatus(initial, "audio")} />,
        );
        expect(screen.getByText(copy)).toBeTruthy();
        expect(
            screen.queryByText("Writing the summary, title and topics."),
        ).toBeNull();
    });
    it.each([
        "owner",
        "curator",
        "member",
    ] as const)("keeps only server-authorized Organization actions for %s", (role) => {
        const initial = data();
        initial.steps.learn = {
            state: "failed",
            reason: "lost",
            waitingFor: null,
            actions: role === "member" ? [] : ["retry"],
        };
        const onLearn = vi.fn();
        const onReviewLearn = vi.fn();
        const props = {
            itemId: initial.itemId,
            kind: "audio" as const,
            view: "org" as const,
            isOwn: role === "owner",
            canCurate: role === "curator",
            folders: [],
            folderAssignments: [],
            onSelectFolder: vi.fn(),
            onAddToFolder: vi.fn(),
            onRemoveFromFolder: vi.fn(),
            onLearn,
            onReviewLearn,
        };
        const { rerender } = render(
            <ItemWorkflow {...props} initialData={initial} />,
        );
        if (role === "member")
            expect(
                screen.queryByRole("button", { name: "Try again" }),
            ).toBeNull();
        else fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onLearn).toHaveBeenCalledTimes(role === "member" ? 0 : 1);
        const review = {
            ...initial,
            steps: {
                ...initial.steps,
                learn: {
                    state: "waiting" as const,
                    reason: "review_pending",
                    waitingFor: { kind: "learnReview" },
                    actions: role === "member" ? [] : ["reviewLearn" as const],
                },
            },
        };
        rerender(<ItemWorkflow {...props} initialData={review} />);
        if (role === "member")
            expect(
                screen.queryByRole("button", { name: "Review Learn" }),
            ).toBeNull();
        else
            fireEvent.click(
                screen.getByRole("button", { name: "Review Learn" }),
            );
        expect(onReviewLearn).toHaveBeenCalledTimes(role === "member" ? 0 : 1);
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
