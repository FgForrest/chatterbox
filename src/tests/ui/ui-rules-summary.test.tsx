// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryWidget } from "@/components/summary/summary-widget";

const mocks = vi.hoisted(() => ({ save: vi.fn(), summarize: vi.fn() }));
const translate = (text: string) => text;
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
}));
vi.mock("@/components/help/help-button", () => ({ HelpLink: () => null }));
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: {
            summaryId: "summary",
            revision: 0,
            summary: "Original text",
            keyPoints: [],
            actionItems: ["Follow up"],
            source: "riffado",
            canEditSummary: true,
        },
        summaryLoaded: true,
        isSummarizing: false,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryProfileId: "profile",
        summaryProfileOptions: [],
        summaryProfilesLoading: false,
        handleSummarize: mocks.summarize,
        saveSummary: mocks.save,
        recheckSummary: vi.fn(),
    }),
}));
vi.mock("@/components/tasks/use-recording-tasks", () => ({
    useRecordingTasks: () => ({ data: null, failed: true, reviewing: false }),
}));

beforeEach(() => {
    mocks.save.mockReset().mockResolvedValue(true);
    mocks.summarize.mockReset();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "audio",
    "mail",
] as const)("%s summary editor trigger", (kind) => {
    it("keeps fallback action-item marks neutral", () => {
        render(
            <SummaryWidget
                itemId="item"
                kind={kind}
                canChange
                contentText="Source"
                widgetId="summary"
                taskWidgetId="tasks"
                workflowVisible={false}
            />,
        );
        const mark = screen
            .getByText("Follow up")
            .closest("li")
            ?.querySelector("svg");
        expect(mark?.classList.contains("text-muted-foreground")).toBe(true);
        expect(mark?.getAttribute("class")).not.toMatch(/text-(tasks|primary)/);
    });
    it.each([
        "Save",
        "Cancel",
    ])("preserves the draft on repeated activation and returns focus after %s", async (action) => {
        render(
            <SummaryWidget
                itemId="item"
                kind={kind}
                canChange
                contentText="Source"
                widgetId="summary"
                taskWidgetId="tasks"
                workflowVisible={false}
            />,
        );
        const trigger = screen.getByRole("button", { name: "Edit summary" });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-disabled")).toBe("true");
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        fireEvent.change(screen.getByLabelText(/Summary text/), {
            target: { value: "Keep this draft" },
        });
        fireEvent.click(trigger);
        expect(screen.getByDisplayValue("Keep this draft")).toBeTruthy();
        expect(mocks.save).not.toHaveBeenCalled();
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: action })),
        );
        expect(document.activeElement).toBe(trigger);
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        if (action === "Save") expect(mocks.save).toHaveBeenCalledOnce();
        else expect(mocks.save).not.toHaveBeenCalled();
        expect(mocks.summarize).not.toHaveBeenCalled();
    });
});
