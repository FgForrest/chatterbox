// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("useTranscriptionSummary requests", () => {
    it.each([
        { channel: "mail", profileId: "" },
        { channel: "mail", profileId: "mail-profile" },
        { channel: "audio", profileId: "" },
        { channel: "audio", profileId: "audio-profile" },
    ] as const)("fetches and generates $channel summaries with profile '$profileId'", async ({
        channel,
        profileId,
    }) => {
        const itemId = `${channel}-1`;
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.startsWith("/api/settings/profiles?")) {
                return Response.json({ profiles: [] });
            }
            return Response.json({
                summary: init?.method === "POST" ? "Generated summary" : null,
                source: "riffado",
                keyPoints: [],
                actionItems: [],
            });
        });
        vi.stubGlobal("fetch", fetch);
        const { result } = renderHook(() =>
            useTranscriptionSummary({
                recordingId: itemId,
                transcriptionText: channel === "audio" ? "Transcript" : null,
                profileChannel: channel,
            }),
        );
        await waitFor(() => {
            expect(result.current.summaryLoaded).toBe(true);
            expect(result.current.summaryProfilesLoading).toBe(false);
        });
        expect(fetch).toHaveBeenCalledWith(
            `/api/settings/profiles?channel=${channel}&pageSize=100`,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(fetch).toHaveBeenCalledWith(
            `/api/recordings/${itemId}/summary?source=riffado`,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        if (profileId) {
            act(() => result.current.setSummaryProfileId(profileId));
        }

        await act(async () => {
            await result.current.handleSummarize();
        });

        expect(fetch).toHaveBeenCalledWith(
            `/api/recordings/${itemId}/summary`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream, application/json",
                },
                body: JSON.stringify(profileId ? { profileId } : {}),
            },
        );
        expect(result.current.summaryData?.summary).toBe("Generated summary");
        expect(result.current.isSummarizing).toBe(false);
    });
});
