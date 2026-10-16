// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStrip } from "@/components/pipeline/workflow-indicator";
import type {
    WorkflowStatus,
    WorkflowStepState,
} from "@/lib/pipeline/workflow-status";

vi.mock("next-intl", () => ({
    useExtracted:
        () =>
        (
            input: string | { message: string },
            values?: Record<string, unknown>,
        ) => {
            const text = typeof input === "string" ? input : input.message;
            return text.replace(/\{(\w+)\}/g, (_match, key: string) =>
                String(values?.[key] ?? ""),
            );
        },
}));

const states: Array<[WorkflowStepState, string]> = [
    ["done", "Done"],
    ["next", "Next"],
    ["review", "Review needed"],
    ["working", "Running"],
    ["queued", "Queued"],
    ["waiting", "Waiting"],
    ["others", "Waiting for a curator"],
    ["problem", "Failed"],
    ["outdated", "Outdated"],
    ["manual", "Manual"],
    ["skipped", "Skipped"],
];

function workflow(overrides: Partial<WorkflowStatus> = {}): WorkflowStatus {
    return {
        visible: true,
        steps: [
            { id: "record", state: "done", current: false },
            { id: "categorize", state: "next", current: true },
            { id: "transcribe", state: "waiting", current: false },
        ],
        status: {
            actor: "yours",
            message: "profilesDisagree",
            action: "chooseProfile",
        },
        ...overrides,
    };
}

function workflowWithSteps(count: 6 | 7): WorkflowStatus {
    const steps: WorkflowStatus["steps"] = [
        { id: "record", state: "done", current: false },
        { id: "categorize", state: "done", current: false },
        { id: "transcribe", state: "done", current: false },
        { id: "learn", state: "review", current: true },
        { id: "summary", state: "waiting", current: false },
        { id: "taskReview", state: "waiting", current: false },
    ];
    if (count === 7) {
        steps.push({ id: "share", state: "waiting", current: false });
    }
    return workflow({ steps });
}

function mockStripWidth(width: number) {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            private readonly callback: ResizeObserverCallback;

            constructor(callback: ResizeObserverCallback) {
                this.callback = callback;
            }

            observe(target: Element) {
                this.callback(
                    [
                        {
                            target,
                            contentRect: { width },
                        } as ResizeObserverEntry,
                    ],
                    this as unknown as ResizeObserver,
                );
            }

            unobserve() {}

            disconnect() {}
        },
    );
}

describe("WorkflowStrip", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each([
        [6, 820, "full"],
        [7, 820, "focused"],
        [6, 390, "compact"],
        [7, 390, "compact"],
        [6, 360, "compact"],
        [7, 360, "compact"],
    ] as const)("uses %s-step %s px density %s without dropping accessible labels", async (count, width, density) => {
        mockStripWidth(width);
        render(<WorkflowStrip workflow={workflowWithSteps(count)} />);

        await waitFor(() =>
            expect(
                screen
                    .getByRole("region", { name: "Workflow" })
                    .getAttribute("data-density"),
            ).toBe(density),
        );
        expect(
            screen.getByRole("listitem", {
                name: "Task review, Waiting",
            }),
        ).toBeTruthy();
        if (count === 7) {
            expect(
                screen.getByRole("listitem", {
                    name: "Share, Waiting",
                }),
            ).toBeTruthy();
        }
    });

    it("keeps every step in one non-wrapping row", () => {
        render(<WorkflowStrip workflow={workflow()} />);
        const list = screen.getByRole("list", { name: "Workflow steps" });
        expect(list.className).toContain("flex-nowrap");
        expect(list.className).not.toContain("flex-wrap");
    });

    it("renders every state with a visible word", () => {
        mockStripWidth(4_000);
        render(
            <WorkflowStrip
                workflow={workflow({
                    steps: states.map(([state], index) => ({
                        id: index === 0 ? "record" : "summary",
                        state,
                        current: state === "review",
                        ...(state === "skipped" ? { reason: "hosted" } : {}),
                    })),
                    status: {
                        actor: "yours",
                        message: "learnReview",
                        params: { count: 1 },
                        action: "reviewLearn",
                    },
                })}
            />,
        );
        const list = within(
            screen.getByRole("list", { name: "Workflow steps" }),
        );
        for (const [, word] of states) {
            expect(list.getByText(word)).toBeTruthy();
        }
    });

    it("marks only the current step", () => {
        render(<WorkflowStrip workflow={workflow()} />);
        expect(
            screen
                .getByRole("listitem", { name: "Categorize, Next" })
                .getAttribute("aria-current"),
        ).toBe("step");
        expect(
            screen
                .getByRole("listitem", { name: "Record, Done" })
                ?.hasAttribute("aria-current"),
        ).toBe(false);
    });

    it.each([
        ["file", "File it"],
        ["chooseProfile", "Choose profile"],
        ["transcribe", "Transcribe"],
        ["reviewLearn", "Review Learn"],
        ["reviewTasks", "Review tasks"],
        ["shareNow", "Share now"],
        ["retry", "Try again"],
        ["processAgain", "Process again"],
    ] as const)("calls the %s handler", (action, label) => {
        const onAction = vi.fn();
        render(
            <WorkflowStrip
                workflow={workflow({
                    status: {
                        actor: "yours",
                        message: "profilesDisagree",
                        action,
                    },
                })}
                onAction={onAction}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: label }));
        expect(onAction).toHaveBeenCalledWith(action);
    });

    it("uses a polite status region and the actor lead", () => {
        render(<WorkflowStrip workflow={workflow()} />);
        const status = screen.getByRole("status");
        expect(status.getAttribute("aria-live")).toBe("polite");
        expect(status.textContent).toContain("Your turn.");
        expect(status.textContent).toContain(
            "The folders suggest different profiles. Choose one to continue.",
        );
    });

    it.each([
        ["transcriptionQueued", "Transcription starts shortly."],
        ["learnQueued", "Learn starts shortly."],
        ["summaryQueued", "Writing starts shortly."],
        ["taskReviewQueued", "Task review starts shortly."],
        ["shareQueued", "Sharing starts shortly."],
    ] as const)("renders the whole %s queued sentence", (message, sentence) => {
        render(
            <WorkflowStrip
                workflow={workflow({
                    status: { actor: "queued", message },
                })}
            />,
        );

        expect(screen.getByRole("status").textContent).toBe(
            `Queued. ${sentence}`,
        );
    });

    it("renders the manual transcription handoff and action", () => {
        const onAction = vi.fn();
        render(
            <WorkflowStrip
                workflow={workflow({
                    status: {
                        actor: "yours",
                        message: "manualTranscription",
                        action: "transcribe",
                    },
                })}
                onAction={onAction}
            />,
        );

        expect(screen.getByRole("status").textContent).toContain(
            "Your turn. Transcribe the recording; the next steps then run by themselves.",
        );
        fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
        expect(onAction).toHaveBeenCalledWith("transcribe");
    });

    it("renders a plain generic failure without a reason code", () => {
        render(
            <WorkflowStrip
                workflow={workflow({
                    status: {
                        actor: "problem",
                        message: "stepFailed",
                        params: { step: "summary" },
                        action: "retry",
                    },
                })}
            />,
        );

        const text = screen.getByRole("status").textContent ?? "";
        expect(text).toContain(
            "This step failed. Try again; if it keeps failing, check its provider in Settings.",
        );
        expect(text).not.toContain("UNKNOWN_FAILURE");
    });

    it("renders nothing when the workflow is complete", () => {
        const { container } = render(
            <WorkflowStrip
                workflow={workflow({ visible: false, status: null })}
            />,
        );
        expect(container.innerHTML).toBe("");
    });
});
