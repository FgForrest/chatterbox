// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryWidget } from "@/components/summary/summary-widget";
import type { SummaryData } from "@/hooks/use-transcription-summary";
import type { WorkflowWidgetState } from "@/lib/pipeline/workflow-widgets";

const mocks = vi.hoisted(() => ({
    copy: vi.fn(),
    download: vi.fn(),
    handleSummarize: vi.fn(),
    recheckSummary: vi.fn(),
    setSummaryExpanded: vi.fn(),
    setSummaryProfileId: vi.fn(),
    useSummary: vi.fn(),
}));

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: mocks.useSummary,
}));

vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => (
        <>
            <button type="button" onClick={mocks.download}>
                Download Markdown
            </button>
            <button type="button" onClick={mocks.copy}>
                Copy Markdown
            </button>
        </>
    ),
}));

vi.mock("@/components/markdown", () => ({
    Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/help/help-button", () => ({
    HelpLink: ({ label }: { label: string }) => (
        <button type="button">{label}</button>
    ),
}));

vi.mock("@/components/tasks/use-recording-tasks", () => ({
    useRecordingTasks: () => ({}),
}));

vi.mock("@/components/tasks/recording-tasks", () => ({
    RecordingTasks: ({
        fallback,
        allowAdd,
    }: {
        fallback?: ReactNode;
        allowAdd?: boolean;
    }) => (
        <div data-testid="recording-tasks" data-allow-add={String(allowAdd)}>
            Accepted task
            {fallback}
        </div>
    ),
}));

vi.mock("@/components/tasks/task-review-dialog", () => ({
    TaskReviewLink: ({ allowAdd }: { allowAdd?: boolean }) => (
        <div data-testid="task-review" data-allow-add={String(allowAdd)} />
    ),
}));

vi.mock("@/components/ui/select", () => ({
    Select: ({
        children,
        onValueChange,
    }: {
        children: ReactNode;
        onValueChange: (value: string) => void;
    }) => (
        <div>
            {children}
            <button type="button" onClick={() => onValueChange("profile-2")}>
                Choose second profile
            </button>
        </div>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectTrigger: ({
        children,
        ...props
    }: {
        children: ReactNode;
        "aria-label"?: string;
    }) => <div {...props}>{children}</div>,
    SelectValue: () => <>Daily notes</>,
}));

interface HookState {
    summaryData: SummaryData | null;
    summaryLoaded: boolean;
    isSummarizing: boolean;
    summaryProgress: {
        phase: "passes" | "merging";
        completed: number;
        total: number;
    } | null;
    summaryElapsedMs: number;
    summaryExpanded: boolean;
    setSummaryExpanded: typeof mocks.setSummaryExpanded;
    summaryProfileId: string;
    setSummaryProfileId: typeof mocks.setSummaryProfileId;
    summaryProfileOptions: Array<{
        id: string;
        name: string;
    }>;
    summaryProfilesLoading: boolean;
    handleSummarize: typeof mocks.handleSummarize;
    recheckSummary: typeof mocks.recheckSummary;
}

let state: HookState;

function summary(overrides: Partial<SummaryData> = {}): SummaryData {
    return {
        summary: "A concise result",
        keyPoints: ["First point"],
        actionItems: ["Send the proposal"],
        source: "riffado",
        provider: "OpenAI",
        model: "gpt-summary",
        multiPass: { roundsRequested: 3, passesUsed: 3, merged: true },
        stale: true,
        scopeChanged: true,
        ...overrides,
    };
}

function resetState(): void {
    state = {
        summaryData: summary(),
        summaryLoaded: true,
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: mocks.setSummaryExpanded,
        summaryProfileId: "profile-1",
        setSummaryProfileId: mocks.setSummaryProfileId,
        summaryProfileOptions: [
            { id: "profile-1", name: "Daily notes" },
            { id: "profile-2", name: "Customer follow-up" },
        ],
        summaryProfilesLoading: false,
        handleSummarize: mocks.handleSummarize,
        recheckSummary: mocks.recheckSummary,
    };
    mocks.useSummary.mockImplementation(() => state);
}

function widget(
    overrides: Partial<WorkflowWidgetState> = {},
): WorkflowWidgetState {
    return {
        visible: true,
        active: false,
        collapsed: false,
        frame: "inline",
        tone: "quiet",
        action: null,
        ...overrides,
    };
}

interface RenderWidgetOptions {
    canChange?: boolean;
    learnHold?: "running" | "correcting" | "review" | null;
    profileName?: string;
    workflowVisible?: boolean;
    widget?: WorkflowWidgetState;
}

function getWidget(kind: "audio" | "mail", options: RenderWidgetOptions = {}) {
    return (
        <SummaryWidget
            itemId={`${kind}-1`}
            kind={kind}
            canChange={options.canChange ?? true}
            contentText="Source text"
            canSummarize
            canSwitchSource={kind === "audio"}
            onSourceChange={vi.fn()}
            widget={options.widget ?? widget()}
            taskWidget={widget()}
            workflowVisible={options.workflowVisible ?? false}
            profileName={options.profileName ?? "Daily notes"}
            widgetId={`${kind}-summary`}
            taskWidgetId={`${kind}-tasks`}
            learnHold={options.learnHold}
        />
    );
}

function renderWidget(
    kind: "audio" | "mail",
    options: RenderWidgetOptions = {},
) {
    return render(getWidget(kind, options));
}

beforeEach(() => {
    vi.clearAllMocks();
    resetState();
});

afterEach(cleanup);

describe.each(["audio", "mail"] as const)("%s summary widget", (kind) => {
    it("shows the profile name on the collapsed workflow line", () => {
        renderWidget(kind, {
            profileName: "Customer follow-up",
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        expect(screen.getByText("Customer follow-up")).toBeTruthy();
    });

    it("starts a first summary from the compact line in one click", () => {
        state.summaryData = null;
        renderWidget(kind, {
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        fireEvent.click(screen.getByRole("button", { name: "Summarize" }));

        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("keeps a manually started summary inline while it runs", () => {
        state.summaryData = null;
        mocks.handleSummarize.mockImplementationOnce(() => {
            state.isSummarizing = true;
        });
        const rendered = renderWidget(kind);

        fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
        rendered.rerender(getWidget(kind));

        expect(screen.getByText("Generating summary…")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("offers every shared header action", () => {
        renderWidget(kind);

        fireEvent.click(screen.getByRole("button", { name: "Re-summarize" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Choose second profile" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Download Markdown" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Collapse summary" }),
        );

        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
        expect(mocks.setSummaryProfileId).toHaveBeenCalledWith("profile-2");
        expect(mocks.download).toHaveBeenCalledOnce();
        expect(mocks.copy).toHaveBeenCalledOnce();
        expect(mocks.setSummaryExpanded).toHaveBeenCalledWith(false);
    });

    it("starts a first summary inline", () => {
        state.summaryData = null;
        renderWidget(kind);

        fireEvent.click(screen.getByRole("button", { name: "Summarize" }));

        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows the shared body, metadata and action-item fallback", () => {
        renderWidget(kind);

        expect(screen.getByText("A concise result")).toBeTruthy();
        expect(screen.getByText("Key Points")).toBeTruthy();
        expect(screen.getByText("First point")).toBeTruthy();
        expect(screen.getByText("OpenAI")).toBeTruthy();
        expect(screen.getByText("gpt-summary")).toBeTruthy();
        expect(screen.getByText("multi-pass · {passes}")).toBeTruthy();
        expect(
            screen.getByText("May contain stale names or terms"),
        ).toBeTruthy();
        expect(
            screen.getByText("Folders changed since this summary:"),
        ).toBeTruthy();
        expect(screen.getByText("Match tasks again")).toBeTruthy();
        expect(screen.getByText("Send the proposal")).toBeTruthy();
        expect(
            screen
                .getByTestId("recording-tasks")
                .getAttribute("data-allow-add"),
        ).toBe("true");
    });

    it("does not offer adding tasks before there is a summary", () => {
        state.summaryData = null;
        renderWidget(kind);

        const taskViews = [
            ...screen.queryAllByTestId("recording-tasks"),
            ...screen.queryAllByTestId("task-review"),
        ];
        expect(taskViews.length).toBeGreaterThan(0);
        for (const view of taskViews) {
            expect(view.getAttribute("data-allow-add")).toBe("false");
        }
    });

    it("shows multi-pass progress and elapsed time while running", () => {
        state.isSummarizing = true;
        state.summaryProgress = { phase: "passes", completed: 2, total: 3 };
        state.summaryElapsedMs = 65_000;
        renderWidget(kind);

        expect(
            screen.getByText("Summarizing — {completed}/{total} passes · 1:05"),
        ).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows a loading state before the summary request settles", () => {
        state.summaryLoaded = false;
        state.summaryData = null;
        renderWidget(kind);

        expect(screen.getByText("Loading…")).toBeTruthy();
    });

    it("uses the read-only empty state", () => {
        state.summaryData = null;
        renderWidget(kind, { canChange: false });

        expect(screen.getByText("No summary yet.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();
    });

    it.each([
        ["running", "The summary waits while Learn checks"],
        ["correcting", "The summary waits while Learn corrects"],
        ["review", "The summary waits for your Learn review"],
    ] as const)("shows the Learn %s hold", (learnHold, text) => {
        state.summaryData = null;
        renderWidget(kind, { learnHold });

        expect(screen.getByText(new RegExp(text))).toBeTruthy();
    });

    it("expands a compact workflow line inline", () => {
        renderWidget(kind, {
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        fireEvent.click(screen.getByRole("button", { name: "View summary" }));

        expect(screen.getByText("A concise result")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    if (kind === "audio") {
        it("keeps the source switcher audio-only", () => {
            renderWidget(kind);
            expect(
                screen.getByRole("group", { name: "Summary source" }),
            ).toBeTruthy();
        });
    } else {
        it("does not show the recording source switcher", () => {
            renderWidget(kind);
            expect(
                screen.queryByRole("group", { name: "Summary source" }),
            ).toBeNull();
        });
    }
});
