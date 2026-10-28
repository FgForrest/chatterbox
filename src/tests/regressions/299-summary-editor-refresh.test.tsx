// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { SummaryWidget } from "@/components/summary/summary-widget";
import type { SummaryData } from "@/hooks/use-transcription-summary";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (message: string) => message,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/help/help-button", () => ({ HelpLink: () => null }));
vi.mock("@/components/product-name-provider", () => ({
    useProductName: () => "Chatterbox",
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("@/components/dashboard/recording-language", () => ({
    RecordingLanguage: () => null,
}));
vi.mock("@/components/dashboard/transcript-view", () => ({
    TranscriptView: () => null,
}));
vi.mock("@/components/dashboard/transcript-chapter-bar", () => ({
    TranscriptChapterBar: () => null,
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/people/speaker-tags", () => ({
    SpeakerTags: () => null,
    confirmedAttributions: () => ({}),
}));
vi.mock("@/hooks/use-transcript-topics", () => ({
    useTranscriptTopics: () => ({
        topics: [],
        detecting: false,
        detect: vi.fn(),
    }),
}));
vi.mock("@/hooks/use-learn-follow-ups", () => ({
    useLearnFollowUps: () => ({
        held: false,
        correcting: false,
        follow: vi.fn(),
    }),
}));
vi.mock("@/components/tasks/use-recording-tasks", () => ({
    useRecordingTasks: () => ({}),
}));
vi.mock("@/components/tasks/recording-tasks", () => ({
    RecordingTasks: () => null,
}));
vi.mock("@/components/tasks/task-review-dialog", () => ({
    TaskReviewLink: () => null,
}));

let summary: SummaryData;
let requests: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
    vi.clearAllMocks();
    summary = {
        summaryId: "initial-row",
        summary: "Initial summary",
        source: "riffado",
        revision: 0,
        keyPoints: [],
        actionItems: [],
        availableSources: ["riffado"],
        canEditSummary: true,
    };
    requests = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.startsWith("/api/settings/profiles"))
            return Response.json({
                profiles: [
                    {
                        id: "profile",
                        name: "Notes",
                        isDefault: true,
                        scope: "personal",
                    },
                ],
            });
        if (init?.method === "PUT")
            return Response.json(
                { error: "The summary changed" },
                { status: 409 },
            );
        if (init?.method === "POST")
            return Response.json(
                { error: "The summary changed" },
                { status: 409 },
            );
        return Response.json(summary);
    });
    vi.stubGlobal("fetch", requests);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const widget = (kind: "audio" | "mail", refreshKey: number) => (
    <SummaryWidget
        itemId="item"
        kind={kind}
        canChange
        contentText="Transcript"
        workflowVisible={false}
        widgetId="summary"
        taskWidgetId="tasks"
        refreshKey={refreshKey}
    />
);

describe.each([
    "audio",
    "mail",
] as const)("%s real summary hook and widget", (kind) => {
    it("keeps the draft and its initial identity/revision across a background refresh and reports conflict", async () => {
        const view = render(widget(kind, 0));
        fireEvent.click(
            await screen.findByRole("button", { name: "Edit summary" }),
        );
        fireEvent.change(screen.getByLabelText(/Summary text/), {
            target: { value: "My original draft" },
        });
        summary = {
            ...summary,
            summaryId: "recreated-row",
            summary: "Other tab changed it",
            revision: 1,
        };
        await act(async () => view.rerender(widget(kind, 1)));
        await waitFor(() =>
            expect(
                requests.mock.calls.filter(
                    ([url, init]) =>
                        String(url).includes("/summary?") && !init?.method,
                ),
            ).toHaveLength(2),
        );
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Save" })),
        );
        const put = requests.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
            summaryId: "initial-row",
            revision: 0,
            summary: "My original draft",
        });
        expect(
            (screen.getByLabelText(/Summary text/) as HTMLTextAreaElement)
                .value,
        ).toBe("My original draft");
        expect(toast.error).toHaveBeenCalledWith(
            "The summary changed. Your draft is kept. Reload before trying again.",
        );
        expect(screen.queryByText("Summary saved")).toBeNull();
    });

    it("keeps the version the user agreed to replace while the confirmation is open", async () => {
        summary.editedAt = "2026-10-28T10:00:00Z";
        const view = render(widget(kind, 0));
        const rerun = await screen.findByRole("button", {
            name: "Re-summarize",
        });
        await waitFor(() =>
            expect((rerun as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(rerun);
        summary = {
            ...summary,
            summaryId: "new-row",
            revision: 2,
            summary: "Other tab changed it",
        };
        await act(async () => view.rerender(widget(kind, 1)));
        await waitFor(() =>
            expect(screen.getByText("Other tab changed it")).toBeTruthy(),
        );
        await act(async () =>
            fireEvent.click(
                within(screen.getByRole("dialog")).getByRole("button", {
                    name: "Re-summarize",
                }),
            ),
        );
        const post = requests.mock.calls.find(
            ([, init]) => init?.method === "POST",
        );
        expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
            replaceEdited: true,
            summaryId: "initial-row",
            revision: 0,
        });
        expect(toast.error).toHaveBeenCalled();
    });
});

describe("dashboard transcription panel with the real summary widget and hook", () => {
    it.each([
        { view: undefined, readOnly: false, icons: true },
        { view: "private" as const, readOnly: false, icons: true },
        { view: "org" as const, readOnly: false, icons: false },
        { view: "org" as const, readOnly: true, icons: false },
        { view: "received" as const, readOnly: true, icons: false },
    ])("keeps the explicit $view view of an item that is shared, read-only: $readOnly", async ({
        view,
        readOnly,
        icons,
    }) => {
        render(
            <TranscriptionPanel
                recording={{
                    id: "item",
                    filename: "Meeting.ogg",
                    duration: 1000,
                    filesize: 10,
                    startTime: "2026-10-01T00:00:00Z",
                    deviceSn: "demo-device",
                    view,
                }}
                transcripts={[{ source: "riffado", text: "Transcript" }]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                shared
                readOnly={readOnly}
            />,
        );
        await screen.findByText("Initial summary");
        expect(
            Boolean(screen.queryByRole("button", { name: "Edit summary" })),
        ).toBe(icons);
        expect(
            Boolean(screen.queryByRole("button", { name: "Summary remarks" })),
        ).toBe(icons);
        const summaryGet = requests.mock.calls.find(([url]) =>
            String(url).includes("/summary?"),
        );
        expect(
            new URL(
                String(summaryGet?.[0]),
                "https://example.test",
            ).searchParams.get("view") ?? "private",
        ).toBe(view ?? "private");
        if (icons) {
            fireEvent.click(screen.getByRole("button", { name: "Plaud" }));
            await waitFor(() =>
                expect(
                    requests.mock.calls.some(([url]) =>
                        String(url).includes("source=plaud"),
                    ),
                ).toBe(true),
            );
            expect(
                screen.queryByRole("button", { name: "Edit summary" }),
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: "Summary remarks" }),
            ).toBeNull();
        }
    });
});
