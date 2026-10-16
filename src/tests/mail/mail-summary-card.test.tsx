// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailSummaryCard } from "@/components/mail/mail-summary-card";
import type { WorkflowWidgetState } from "@/lib/pipeline/workflow-widgets";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/components/markdown", () => ({
    Markdown: ({ children }: { children: string }) => <>{children}</>,
}));

vi.mock("@/components/tasks/use-recording-tasks", () => ({
    useRecordingTasks: () => ({}),
}));

vi.mock("@/components/tasks/recording-tasks", () => ({
    RecordingTasks: () => <div>Accepted task: send the proposal</div>,
}));

vi.mock("@/components/tasks/task-review-dialog", () => ({
    TaskReviewLink: () => null,
}));

const mail = {
    id: "mail-1",
    filename: "Harbor proposal follow-up",
    duration: 0,
    filesize: 512,
    startTime: "2026-10-16T10:00:00.000Z",
    deviceSn: "mail",
    kind: "mail",
} satisfies Recording;

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

function stubSummary(summary: string | null) {
    const fetch = vi.fn(async () =>
        Response.json({
            summary,
            keyPoints: [],
            actionItems: [],
        }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

function renderSummary({
    state,
    workflowVisible,
}: {
    state: WorkflowWidgetState;
    workflowVisible: boolean;
}) {
    return render(
        <MailSummaryCard
            mail={mail}
            canChange
            widget={state}
            workflowVisible={workflowVisible}
            profileName="Customer follow-up"
            widgetId="mail-summary-mail-1"
            taskWidgetId="mail-task-review-mail-1"
        />,
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("mail summary workflow presentation", () => {
    it("shows the profile name on the collapsed workflow line", async () => {
        stubSummary("Proposal summary");
        renderSummary({
            state: widget({ collapsed: true }),
            workflowVisible: true,
        });

        expect(await screen.findByText("Customer follow-up")).toBeTruthy();
        expect(screen.queryByText("Recordings")).toBeNull();
    });

    it("expands a workflow line inline without opening a dialog", async () => {
        stubSummary("Proposal summary");
        renderSummary({
            state: widget({ collapsed: true }),
            workflowVisible: true,
        });

        fireEvent.click(
            await screen.findByRole("button", { name: "View summary" }),
        );

        expect(await screen.findByText("Proposal summary")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("starts a first summary from the compact line in one click", async () => {
        const fetch = stubSummary(null);
        renderSummary({
            state: widget({ collapsed: true }),
            workflowVisible: true,
        });

        fireEvent.click(
            await screen.findByRole("button", { name: "Summarize" }),
        );

        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/mail-1/summary",
                expect.objectContaining({ method: "POST" }),
            ),
        );
    });

    it.each([
        ["with a summary", "Proposal summary"],
        ["without a summary", null],
    ])("restores the full card and accepted tasks %s", async (_name, summary) => {
        stubSummary(summary);
        renderSummary({
            state: widget(),
            workflowVisible: false,
        });

        expect(
            await screen.findByText("Accepted task: send the proposal"),
        ).toBeTruthy();
        expect(
            document.querySelector("[data-workflow-widget-line]"),
        ).toBeNull();
        if (summary) {
            expect(screen.getByText(summary)).toBeTruthy();
        } else {
            expect(
                screen.getByText("Ready when you are. Generate a summary."),
            ).toBeTruthy();
        }
    });

    it("uses a line while a dialog-frame run is working", async () => {
        stubSummary(null);
        renderSummary({
            state: widget({
                active: true,
                frame: "dialog",
                tone: "working",
            }),
            workflowVisible: false,
        });

        await waitFor(() =>
            expect(
                document.querySelector("[data-workflow-widget-line]"),
            ).toBeTruthy(),
        );
        expect(screen.getByText("Generating the summary")).toBeTruthy();
    });
});
