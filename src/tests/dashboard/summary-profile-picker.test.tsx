// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, unknown>) =>
        Object.entries(values ?? {}).reduce(
            (result, [key, value]) => result.replace(`{${key}}`, String(value)),
            text,
        ),
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/components/dashboard/transcript-view", () => ({
    TranscriptView: () => <div>Transcript body</div>,
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("@/components/people/speaker-tags", () => ({
    SpeakerTags: () => null,
    confirmedAttributions: () => ({}),
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
vi.mock("@/hooks/use-transcript-topics", () => ({
    useTranscriptTopics: () => ({
        topics: null,
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

import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";

describe("per-run summary profile picker", () => {
    let requests: Array<{ url: string; method: string; body: unknown }>;

    beforeEach(() => {
        requests = [];
        Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value: vi.fn(),
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                requests.push({ url, method, body });
                if (
                    url === "/api/settings/profiles?channel=audio&pageSize=100"
                ) {
                    return Response.json({
                        profiles: [
                            {
                                id: "default-profile",
                                name: "Everyday recordings",
                                description: null,
                                channel: "audio",
                                scope: "personal",
                                isDefault: true,
                                version: 1,
                                canEdit: true,
                                archivedAt: null,
                                updatedAt: "2026-10-15T00:00:00.000Z",
                            },
                            {
                                id: "interview-profile",
                                name: "Interviews",
                                description: null,
                                channel: "audio",
                                scope: "personal",
                                isDefault: false,
                                version: 1,
                                canEdit: true,
                                archivedAt: null,
                                updatedAt: "2026-10-15T00:00:00.000Z",
                            },
                        ],
                        pagination: {
                            page: 1,
                            pageSize: 100,
                            total: 2,
                            totalPages: 1,
                        },
                    });
                }
                if (url.includes("/summary") && method === "POST") {
                    return Response.json({
                        summary: "Made with the selected profile",
                        keyPoints: [],
                        actionItems: [],
                        source: "riffado",
                    });
                }
                if (url.includes("/summary")) {
                    return Response.json({
                        summary: null,
                        source: "riffado",
                        availableSources: [],
                    });
                }
                return Response.json({ speakers: [] });
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("lists usable profiles for the item channel, defaults to the resolved one, and posts profileId", async () => {
        render(
            <TranscriptionPanel
                recording={{
                    id: "recording-1",
                    filename: "Interview.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "local",
                    kind: "audio",
                }}
                transcripts={[
                    {
                        source: "riffado",
                        text: "Interview transcript",
                        provider: "OpenAI",
                        model: "whisper-1",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );

        const picker = await screen.findByRole("combobox", {
            name: "Processing profile",
        });
        expect(picker.textContent).toContain("Everyday recordings");
        fireEvent.click(picker);
        fireEvent.click(
            await screen.findByRole("option", { name: "Interviews" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Summarize" }));

        await waitFor(() =>
            expect(
                requests.find(
                    (request) =>
                        request.url.includes("/summary") &&
                        request.method === "POST",
                )?.body,
            ).toEqual({ profileId: "interview-profile" }),
        );
    });
});
