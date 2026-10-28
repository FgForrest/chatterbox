// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openWidget } from "@/components/pipeline/workflow-widget";
import { SummaryWidget } from "@/components/summary/summary-widget";
import type { SummaryData } from "@/hooks/use-transcription-summary";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import {
    deriveWorkflowWidgets,
    type WorkflowWidgetState,
} from "@/lib/pipeline/workflow-widgets";
import type { RecordingView } from "@/lib/sharing/view";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

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
    view?: RecordingView;
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
            view={options.view}
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
    it("shows a settled shared step without a generating state", () => {
        state.summaryData = null;
        const data: ItemProcessingPresentation = processingFixture({
            itemId: `${kind}-1`,
            kind,
            legacy: false,
            manualOnly: false,
            phases: {
                categorize: { state: "done", generation: 1, at: "2026-10-01" },
                learn: { state: "done", generation: 1, at: "2026-10-01" },
                summary: {
                    state: "skipped",
                    reason: "shared",
                    generation: 1,
                    at: "2026-10-01",
                },
                taskReview: { state: "done", generation: 1, at: "2026-10-01" },
            },
            profile: null,
            placements: [],
            intents: [],
            outputs: { transcript: true, learn: true, summary: false },
            processAgain: false,
            processAgainReason: null,
            learnFindingsWaiting: 0,
            taskReviewWaiting: 0,
            jobs: { transcription: null, summary: null },
            failures: [],
        });
        const workflow = deriveWorkflowStatus(data, kind);
        const widgets = deriveWorkflowWidgets(data);
        expect(workflow.visible).toBe(true);
        expect(
            workflow.steps.find((step) => step.id === "summary"),
        ).toMatchObject({ state: "skipped", reason: "shared" });
        expect(workflow.status).toBeNull();
        expect(widgets.summary.tone).toBe("quiet");
        renderWidget(kind, {
            canChange: false,
            workflowVisible: widgets.workflowVisible,
            widget: widgets.summary,
        });
        fireEvent.click(screen.getByRole("button", { name: "View summary" }));
        expect(screen.getByText("No summary yet.")).toBeTruthy();
        expect(screen.queryByText(/Generating/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();
    });

    it("shows the profile name on the collapsed workflow line", () => {
        renderWidget(kind, {
            profileName: "Customer follow-up",
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        expect(screen.getByText("Customer follow-up")).toBeTruthy();
    });

    it("hides tasks, summary and metadata until expanded", () => {
        const rendered = renderWidget(kind);
        const content = screen.getByRole("region", { name: "Summary content" });
        fireEvent.click(
            screen.getByRole("button", { name: "Collapse summary" }),
        );
        state.summaryExpanded = false;
        rendered.rerender(getWidget(kind));
        expect(
            screen.getByRole("button", { name: "Expand summary" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("region", { name: "Summary content" }),
        ).toBeNull();
        expect(
            screen.getByTestId("recording-tasks").closest("[hidden]"),
        ).toBeTruthy();
        expect(
            screen.getByText("Send the proposal").closest("[hidden]"),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Expand summary" }));
        state.summaryExpanded = true;
        rendered.rerender(getWidget(kind));
        expect(screen.getByRole("region", { name: "Summary content" })).toBe(
            content,
        );
        expect(
            screen.getByTestId("recording-tasks").closest("[hidden]"),
        ).toBeNull();
        expect(screen.getByText("Send the proposal")).toBeTruthy();
        expect(screen.getByText("gpt-summary")).toBeTruthy();
    });

    it("starts a first summary from the compact line in one click", () => {
        state.summaryData = null;
        renderWidget(kind, {
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        fireEvent.click(
            screen.getAllByRole("button", { name: "Summarize" })[0],
        );

        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("starts a first summary when the processing strip opens the compact line", () => {
        state.summaryData = null;
        renderWidget(kind, {
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        act(() => openWidget(`${kind}-summary`));

        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
    });

    it("expands instead of starting while the compact line cannot run", () => {
        state.summaryData = null;
        state.summaryProfilesLoading = true;
        renderWidget(kind, {
            workflowVisible: true,
            widget: widget({ collapsed: true }),
        });

        act(() => openWidget(`${kind}-summary`));

        expect(mocks.handleSummarize).not.toHaveBeenCalled();
        const heading = screen.getByRole("heading", { name: /^Summary/ });
        expect(heading.closest("[hidden]")).toBeNull();
        expect(heading.closest("[data-workflow-widget]")?.tagName).not.toBe(
            "SPAN",
        );
    });

    it("keeps a manually started summary inline while it runs", () => {
        state.summaryData = null;
        mocks.handleSummarize.mockImplementationOnce(() => {
            state.isSummarizing = true;
        });
        const rendered = renderWidget(kind);

        fireEvent.click(
            screen.getAllByRole("button", { name: "Summarize" })[0],
        );
        rendered.rerender(getWidget(kind));

        expect(screen.getByText("Generating summary…")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("offers every shared header action", () => {
        renderWidget(kind);

        fireEvent.click(screen.getByRole("button", { name: "Re-summarize" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Change summary profile" }),
        );
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

        expect(mocks.handleSummarize).toHaveBeenCalledTimes(2);
        expect(mocks.handleSummarize).toHaveBeenLastCalledWith("profile-2");
        expect(mocks.setSummaryProfileId).toHaveBeenCalledWith("profile-2");
        expect(mocks.download).toHaveBeenCalledOnce();
        expect(mocks.copy).toHaveBeenCalledOnce();
        expect(mocks.setSummaryExpanded).toHaveBeenCalledWith(false);
    });

    it("starts a first summary inline", () => {
        state.summaryData = null;
        renderWidget(kind);

        fireEvent.click(
            screen.getAllByRole("button", { name: "Summarize" })[0],
        );

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

    it("keeps key points inside the summary box and metadata below the task list", () => {
        renderWidget(kind);
        const box = screen.getByRole("region", { name: "Summary content" });
        expect(box.contains(screen.getByText("Key Points"))).toBe(true);
        expect(box.contains(screen.getByText("First point"))).toBe(true);
        expect(box.contains(screen.getByText("gpt-summary"))).toBe(false);
        expect(screen.getByText("gpt-summary").closest("footer")).toBeTruthy();
        expect(
            screen
                .getByRole("button", { name: "Collapse summary" })
                .getAttribute("aria-expanded"),
        ).toBe("true");
        expect(
            screen.getByRole("button", { name: "Re-summarize" }).textContent,
        ).toBe("");
    });

    it("shows the producing profile with no pencil for a read-only viewer", () => {
        state.summaryData = summary({
            profileName: "Historical profile",
            profileId: "old-profile",
            profileVisibility: "readable",
        });
        renderWidget(kind, { canChange: false });
        expect(screen.getByText("Profile")).toBeTruthy();
        expect(screen.getByText("Historical profile")).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Change summary profile" }),
        ).toBeNull();
    });
    it("shows the next-run selection and pencil for an owner without provenance", () => {
        state.summaryData = summary({
            profileName: null,
            profileId: null,
            profileVisibility: "unresolved",
        });
        state.summaryProfileId = "profile-2";
        renderWidget(kind, { profileName: "Assigned profile" });
        expect(screen.getByText("Profile")).toBeTruthy();
        expect(screen.getByText("Customer follow-up")).toBeTruthy();
        expect(screen.queryByText("Assigned profile")).toBeNull();
        expect(
            screen.getByRole("button", { name: "Change summary profile" }),
        ).toBeTruthy();
    });

    it("shows the producing profile and pencil for an owner with provenance", () => {
        state.summaryData = summary({
            profileName: "Historical profile",
            profileId: "old-profile",
            profileVisibility: "readable",
        });
        renderWidget(kind);
        expect(screen.getByText("Profile")).toBeTruthy();
        expect(screen.getByText("Historical profile")).toBeTruthy();
        expect(screen.queryByText("Daily notes")).toBeNull();
        expect(
            screen.getByRole("button", { name: "Change summary profile" }),
        ).toBeTruthy();
    });

    it.each([
        { viewer: "recipient", canChange: false },
        { viewer: "Organization member", canChange: false },
    ])("hides the profile label and pencil for a $viewer with private provenance", ({
        canChange,
    }) => {
        state.summaryData = summary({
            profileName: null,
            profileId: null,
            profileVisibility: "hidden",
        });
        renderWidget(kind, { canChange, profileName: "Assigned profile" });
        expect(screen.queryByText("Profile")).toBeNull();
        expect(screen.queryByText("Daily notes")).toBeNull();
        expect(screen.queryByText("Assigned profile")).toBeNull();
        expect(screen.queryByText("Unknown")).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Change summary profile" }),
        ).toBeNull();
    });

    it.each([
        { viewer: "owner", view: "private" },
        { viewer: "curator", view: "org" },
    ] as const)("shows the next-run selection and working pencil for a $viewer with hidden provenance", ({
        view,
    }) => {
        state.summaryData = summary({
            profileName: null,
            profileId: null,
            profileVisibility: "hidden",
        });
        state.summaryProfileId = "profile-2";
        renderWidget(kind, { view, profileName: "Assigned profile" });
        expect(screen.getByText("Profile")).toBeTruthy();
        expect(screen.getByText("Customer follow-up")).toBeTruthy();
        expect(screen.queryByText("Assigned profile")).toBeNull();
        fireEvent.click(
            screen.getByRole("button", { name: "Change summary profile" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Choose second profile" }),
        );
        expect(mocks.handleSummarize).not.toHaveBeenCalled();
    });

    it("lets a curator re-summarize with their chosen profile when provenance is hidden", () => {
        state.summaryData = summary({
            profileName: null,
            profileId: null,
            profileVisibility: "hidden",
        });
        renderWidget(kind, { view: "org" });
        fireEvent.click(
            screen.getByRole("button", { name: "Change summary profile" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Choose second profile" }),
        );
        expect(mocks.setSummaryProfileId).toHaveBeenCalledWith("profile-2");
        expect(mocks.handleSummarize).toHaveBeenCalledExactlyOnceWith(
            "profile-2",
        );
    });

    it("shows no profile label for a read-only viewer without provenance", () => {
        state.summaryData = summary({
            profileName: null,
            profileId: null,
            profileVisibility: "unresolved",
        });
        renderWidget(kind, { canChange: false });
        expect(screen.queryByText("Profile")).toBeNull();
        expect(screen.queryByText("Daily notes")).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Change summary profile" }),
        ).toBeNull();
    });

    it("choosing a profile before the first summary only sets the next profile", () => {
        state.summaryData = null;
        renderWidget(kind);
        fireEvent.click(
            screen.getByRole("button", { name: "Change summary profile" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Choose second profile" }),
        );
        expect(mocks.setSummaryProfileId).toHaveBeenCalledWith("profile-2");
        expect(mocks.handleSummarize).not.toHaveBeenCalled();
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

    it.each([
        false,
        true,
    ])("shows the earlier-content chip when stale is %s", (stale) => {
        state.summaryData = summary({ olderContent: true, stale });
        renderWidget(kind, { learnHold: "review" });

        expect(
            screen.getByText(
                kind === "mail"
                    ? "Made from an earlier version of the message"
                    : "Made from an earlier transcript",
            ),
        ).toBeTruthy();
        expect(screen.getByText("A concise result")).toBeTruthy();
        expect(
            screen.queryByText("May contain stale names or terms"),
        ).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
        expect(mocks.handleSummarize).toHaveBeenCalledOnce();
    });

    it("shows the earlier-content chip without Regenerate for a read-only viewer", () => {
        state.summaryData = summary({ olderContent: true });
        renderWidget(kind, { canChange: false });

        expect(
            screen.getByText(
                kind === "mail"
                    ? "Made from an earlier version of the message"
                    : "Made from an earlier transcript",
            ),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    });

    it("clears the note after a summary of the current content is loaded", () => {
        state.summaryData = summary({ olderContent: true });
        const rendered = renderWidget(kind);
        state.summaryData = summary({ olderContent: false, stale: false });
        rendered.rerender(getWidget(kind));

        expect(screen.queryByText(/Made from an earlier/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
        expect(screen.getByText("A concise result")).toBeTruthy();
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

it("keeps the existing no-transcript guidance and disables Summarize", () => {
    state.summaryData = null;
    render(
        <SummaryWidget
            itemId="mira-empty"
            kind="audio"
            canChange
            workflowVisible={false}
            widgetId="mira-summary"
            taskWidgetId="mira-tasks"
        />,
    );
    expect(
        screen.getByText(
            "A custom transcript is required before generating a custom summary.",
        ),
    ).toBeTruthy();
    expect(
        screen.getAllByRole<HTMLButtonElement>("button", {
            name: "Summarize",
        })[0].disabled,
    ).toBe(true);
});
