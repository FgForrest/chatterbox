// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const followUps = vi.hoisted(() => ({ held: false, correcting: false }));

vi.mock("next-intl", () => ({
    useLocale: () => "en",
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
        held: followUps.held,
        correcting: followUps.correcting,
        follow: vi.fn(),
    }),
}));

import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";

describe("per-run summary profile picker", () => {
    let requests: Array<{ url: string; method: string; body: unknown }>;
    let itemProfileId: string | null;
    let profiles: Array<Record<string, unknown>>;

    beforeEach(() => {
        requests = [];
        followUps.held = false;
        followUps.correcting = false;
        itemProfileId = "interview-profile";
        profiles = [
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
        ];
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
                        profiles,
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
                        itemProfileId,
                    });
                }
                return Response.json({ speakers: [] });
            }),
        );
    });

    afterEach(async () => {
        cleanup();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        vi.unstubAllGlobals();
    });

    it("lists usable profiles, preselects the item's profile, and posts profileId", async () => {
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
        expect(picker.textContent).toContain("Interviews");
        fireEvent.click(picker);
        fireEvent.click(
            await screen.findByRole("option", {
                name: "Everyday recordings",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Summarize" }));

        await waitFor(() =>
            expect(
                requests.find(
                    (request) =>
                        request.url.includes("/summary") &&
                        request.method === "POST",
                )?.body,
            ).toEqual({ profileId: "default-profile" }),
        );
    });

    it("preselects the member's effective default profile", async () => {
        itemProfileId = null;
        profiles = [
            {
                id: "organization-default",
                name: "Organization recordings",
                description: null,
                channel: "audio",
                scope: "organization",
                isDefault: true,
                isYourDefault: false,
                version: 1,
                canEdit: false,
                archivedAt: null,
                updatedAt: "2026-10-15T00:00:00.000Z",
            },
            {
                id: "member-choice",
                name: "Member's interviews",
                description: null,
                channel: "audio",
                scope: "organization",
                isDefault: false,
                isYourDefault: true,
                version: 1,
                canEdit: false,
                archivedAt: null,
                updatedAt: "2026-10-15T00:00:00.000Z",
            },
        ];

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
        expect(picker.textContent).toContain("Member's interviews");
    });

    it("says a held summary starts after transcript correction", async () => {
        followUps.held = true;
        followUps.correcting = true;

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

        expect(
            await screen.findByText(
                /The summary waits while Learn corrects the transcript, then starts by itself/,
            ),
        ).toBeTruthy();
        expect(screen.queryByText(/waits for your Learn review/)).toBeNull();
        expect(screen.getByRole("button", { name: "Summarize" })).toBeTruthy();
    });
});
