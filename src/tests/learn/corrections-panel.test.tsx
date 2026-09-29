// @vitest-environment jsdom

/**
 * The transcription panel reads a transcript edited by its corrections,
 * shows the original on request, and undoes a correction.
 */

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: null,
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryPreset: "general",
        setSummaryPreset: vi.fn(),
        summaryPromptOptions: [{ id: "general", name: "General" }],
        handleSummarize: vi.fn(),
        handleDeleteSummary: vi.fn(),
    }),
}));
vi.mock("@/components/people/speaker-tags", () => ({
    SpeakerTags: () => null,
    confirmedAttributions: () => ({}),
}));
vi.mock("@/components/learn/learn-review", () => ({ LearnReview: () => null }));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));

import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5_000,
        text: "Máme tu Tavesy.",
    },
];

const CORRECTION = {
    id: "c-1",
    turnIndex: 0,
    charStart: 8,
    charEnd: 14,
    heard: "Tavesy",
    kind: "correct",
    replacement: "Tavesi",
    meaning: "Tavesi",
};

describe("corrections in the transcription panel", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("reads edited, shows the original on request, and undoes a correction", async () => {
        let corrections = [CORRECTION];
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.startsWith("/api/recordings/rec-1/corrections/c-1")) {
                if (init?.method === "DELETE") corrections = [];
                return Response.json({ ok: true });
            }
            if (url.startsWith("/api/recordings/rec-1/corrections")) {
                return Response.json({
                    transcriptionId: "t-1",
                    revision: 0,
                    canUndo: true,
                    corrections,
                });
            }
            return Response.json({ speakers: [] });
        });
        vi.stubGlobal("fetch", fetch);
        const onTranscriptStale = vi.fn();
        render(
            <TranscriptionPanel
                recording={{
                    id: "rec-1",
                    filename: "Kickoff",
                    duration: 5_000,
                    filesize: 1,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "local",
                }}
                transcripts={[
                    {
                        source: "riffado",
                        text: TURNS[0].text,
                        provider: "openai",
                        model: "gpt-4o-transcribe-diarize",
                        turns: TURNS,
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                onTranscriptStale={onTranscriptStale}
            />,
        );
        expect(
            await screen.findByRole("button", {
                name: "Tavesi, heard as Tavesy: show undo",
            }),
        ).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Show original" }));
        expect(screen.getByText("Máme tu Tavesy.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Show edited" }));

        fireEvent.click(
            screen.getByRole("button", {
                name: "Tavesi, heard as Tavesy: show undo",
            }),
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Undo: read Tavesy here again",
            }),
        );
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/recordings/rec-1/corrections/c-1",
                { method: "DELETE" },
            ),
        );
        expect(await screen.findByText("Máme tu Tavesy.")).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Show original" }),
        ).toBeNull();
        expect(onTranscriptStale).toHaveBeenCalled();
    });
});
