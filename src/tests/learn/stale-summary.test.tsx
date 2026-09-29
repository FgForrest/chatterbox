// @vitest-environment jsdom

/**
 * A summary made before the transcript's corrections changed says so, and
 * offers to be made again.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
const handleSummarize = vi.hoisted(() => ({ fn: () => {} }));
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: {
            summary: "Tavesy came.",
            keyPoints: [],
            actionItems: [],
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-mini",
            stale: true,
        },
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryPreset: "general",
        setSummaryPreset: vi.fn(),
        summaryPromptOptions: [{ id: "general", name: "General" }],
        handleSummarize: () => handleSummarize.fn(),
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

describe("a stale summary", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("says it may name things as they were heard, and offers to regenerate", () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ speakers: [] })),
        );
        const regenerate = vi.fn();
        handleSummarize.fn = regenerate;
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
                        text: "Máme tu Tavesy.",
                        provider: "openai",
                        model: "gpt-4o-transcribe-diarize",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );
        expect(
            screen.getByText("May contain stale names or terms"),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
        expect(regenerate).toHaveBeenCalled();
    });
});
