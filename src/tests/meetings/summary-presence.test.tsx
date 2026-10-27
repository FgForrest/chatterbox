// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    false,
    true,
])("summary presence with summary %s", (hasSummary) => {
    it.each([
        0, 2,
    ])("retains top-level meeting metadata with %s candidates", async (agendaCandidateCount) => {
        const fetchMock = vi.fn(async (url: string) =>
            Response.json(
                url.startsWith("/api/settings/")
                    ? { profiles: [] }
                    : {
                          summary: hasSummary ? "Summary" : null,
                          source: "riffado",
                          keyPoints: null,
                          actionItems: null,
                          hasAgenda: true,
                          agendaCandidateCount,
                      },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const { result } = renderHook(() =>
            useTranscriptionSummary({
                recordingId: "recording",
                transcriptionText: null,
            }),
        );
        await waitFor(() => expect(result.current.summaryLoaded).toBe(true));
        expect(result.current.agendaPresence).toEqual({
            hasAgenda: true,
            agendaCandidateCount,
        });
        expect(Boolean(result.current.summaryData?.summary)).toBe(hasSummary);
        expect(
            fetchMock.mock.calls.some(([url]) =>
                /agenda|next-meeting/.test(url),
            ),
        ).toBe(false);
    });
});

it("does not carry a previous recording's presence into the next recording", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            Response.json(
                url.startsWith("/api/settings/")
                    ? { profiles: [] }
                    : {
                          summary: null,
                          hasAgenda: url.includes("first"),
                          agendaCandidateCount: 0,
                      },
            ),
        ),
    );
    const { result, rerender } = renderHook(
        ({ id }) =>
            useTranscriptionSummary({
                recordingId: id,
                transcriptionText: null,
            }),
        { initialProps: { id: "first" } },
    );
    await waitFor(() =>
        expect(result.current.agendaPresence?.hasAgenda).toBe(true),
    );
    rerender({ id: "second" });
    expect(result.current.agendaPresence).toBeUndefined();
    await waitFor(() =>
        expect(result.current.agendaPresence?.hasAgenda).toBe(false),
    );
});
