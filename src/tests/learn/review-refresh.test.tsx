// @vitest-environment jsdom

/**
 * What a finished review changed shows at once: the speaker names (read
 * again, since a review names speakers without a new transcript revision)
 * and the People badge.
 */

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const speakerMounts = vi.hoisted(() => ({ count: 0 }));
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
    SpeakerTags: () => {
        useEffect(() => {
            speakerMounts.count++;
        }, []);
        return null;
    },
    confirmedAttributions: () => ({}),
}));
vi.mock("@/components/learn/learn-review", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/components/learn/learn-review")
    >()),
    LearnReview: ({ onFinished }: { onFinished?: () => void }) => (
        <button type="button" onClick={() => onFinished?.()}>
            finish the review
        </button>
    ),
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import { AppNav } from "@/components/app-nav";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { announceLearnReviewsChanged } from "@/components/learn/review-events";

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Máme tu Tavesy." },
];

describe("after a review is finished", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("reads the speakers again", () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ speakers: [] })),
        );
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
        const before = speakerMounts.count;
        fireEvent.click(
            screen.getByRole("button", { name: "finish the review" }),
        );
        expect(onTranscriptStale).toHaveBeenCalled();
        expect(speakerMounts.count).toBe(before + 1);
    });

    it("counts the People badge again", async () => {
        let waiting = 1;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ count: waiting })),
        );
        render(<AppNav />);
        expect(await screen.findByText("1")).toBeTruthy();
        waiting = 0;
        act(() => announceLearnReviewsChanged());
        await waitFor(() => expect(screen.queryByText("1")).toBeNull());
    });
});
