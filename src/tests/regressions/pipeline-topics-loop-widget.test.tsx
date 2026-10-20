// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SummaryWidget } from "@/components/summary/summary-widget";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";

const mocks = vi.hoisted(() => ({ useSummary: vi.fn() }));
vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: mocks.useSummary,
}));
vi.mock("@/components/markdown", () => ({
    Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("@/components/help/help-button", () => ({ HelpLink: () => null }));
vi.mock("@/components/tasks/use-recording-tasks", () => ({
    useRecordingTasks: () => ({}),
}));
vi.mock("@/components/tasks/recording-tasks", () => ({
    RecordingTasks: () => null,
}));
vi.mock("@/components/tasks/task-review-dialog", () => ({
    TaskReviewLink: () => null,
}));
afterEach(cleanup);

function presentation(
    kind: "audio" | "mail",
    hasSummary: boolean,
): ItemProcessingPresentation {
    const at = new Date().toISOString();
    return {
        itemId: "item",
        kind,
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: { state: "done", generation: 1, at },
            transcribe: { state: "done", generation: 1, at },
            learn: { state: "done", generation: 1, at },
            summary: {
                state: "pending",
                reason: "learn-released",
                generation: 1,
                at,
            },
            taskReview: { state: "done", generation: 1, at },
        },
        profile: {
            id: "profile",
            revisionId: "revision",
            name: "Notes",
            scope: "personal",
            automatic: {
                transcribe: true,
                learn: true,
                summary: true,
                taskReview: false,
            },
        },
        placements: [],
        intents: [],
        outputs: { transcript: true, summary: hasSummary, learn: true },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    };
}

function renderSummary(
    data: ItemProcessingPresentation,
    hasSummary: boolean,
    legacyWorking = false,
) {
    mocks.useSummary.mockReturnValue({
        summaryData: hasSummary
            ? { summary: "Existing summary", keyPoints: [], actionItems: [] }
            : null,
        summaryLoaded: true,
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        handleSummarize: vi.fn(),
        recheckSummary: vi.fn(),
    });
    const widgets = deriveWorkflowWidgets(data);
    render(
        <SummaryWidget
            itemId="item"
            kind={data.kind}
            canChange={false}
            contentText="Source text"
            workflowVisible={widgets.workflowVisible}
            widget={
                legacyWorking
                    ? { ...widgets.summary, active: true, tone: "working" }
                    : widgets.summary
            }
            widgetId="summary"
            taskWidgetId="tasks"
        />,
    );
}

describe.each([
    "audio",
    "mail",
] as const)("%s summary while companion jobs wait", (kind) => {
    it.each([
        "queued",
        "running",
    ] as const)("keeps the existing summary visible when topics/title were aggregated into a %s summary job", (state) => {
        const data = presentation(kind, true);
        data.jobs.summary = state;
        expect(deriveWorkflowWidgets(data).summary).toMatchObject({
            active: true,
            tone: "working",
        });
        renderSummary(data, true);
        expect(screen.getByText("Existing summary")).toBeTruthy();
        expect(screen.queryByText("Generating summary…")).toBeNull();
    });

    it("shows the first-summary spinner while a companion job waits", () => {
        const data = presentation(kind, false);
        data.jobs.topics = "queued";
        renderSummary(data, false);
        expect(screen.getByText("Generating summary…")).toBeTruthy();
    });

    it("keeps existing content visible with an older aggregated working state", () => {
        renderSummary(presentation(kind, true), true, true);
        expect(screen.getByText("Existing summary")).toBeTruthy();
        expect(screen.queryByText("Generating summary…")).toBeNull();
    });
});
