// @vitest-environment jsdom

/**
 * Following what automatic Learn held back once its review is finished:
 * the title, topics and summary are made by jobs nothing on the page
 * started, so without this the page keeps the old title and idle
 * "Generate" buttons while they run.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLearnFollowUps } from "@/hooks/use-learn-follow-ups";

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

/** Answers in order, the last one repeated. */
function answering(...states: { held: boolean; pending: string[] }[]) {
    let index = 0;
    return vi.fn().mockImplementation(async () => {
        const state = states[Math.min(index, states.length - 1)];
        index++;
        return jsonResponse(state);
    });
}

describe("useLearnFollowUps", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("says the recording waits for its review, and does not poll while it does", async () => {
        const fetchMock = answering({ held: true, pending: [] });
        vi.stubGlobal("fetch", fetchMock);
        const onChange = vi.fn();

        const hook = renderHook(() =>
            useLearnFollowUps({
                recordingId: "rec-1",
                enabled: true,
                onChange,
            }),
        );

        await waitFor(() => expect(hook.result.current.held).toBe(true));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/rec-1/follow-ups",
            expect.anything(),
        );
        expect(onChange).not.toHaveBeenCalled();
    });

    it("follows the jobs a finished review queued until none is left", async () => {
        const fetchMock = answering(
            { held: true, pending: [] },
            { held: false, pending: ["learn.release"] },
            { held: false, pending: ["summary", "title.generate", "topics"] },
            { held: false, pending: ["summary"] },
            { held: false, pending: [] },
        );
        vi.stubGlobal("fetch", fetchMock);
        const onChange = vi.fn();
        const hook = renderHook(() =>
            useLearnFollowUps({
                recordingId: "rec-1",
                enabled: true,
                onChange,
            }),
        );
        await waitFor(() => expect(hook.result.current.held).toBe(true));

        act(() => hook.result.current.follow());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(hook.result.current.held).toBe(false);
        // The release queued, what it queued, the title made, the summary
        // made: each a reason to look again.
        expect(onChange).toHaveBeenCalledTimes(4);
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("looks again even when everything finished before the first check", async () => {
        const fetchMock = answering(
            { held: true, pending: [] },
            { held: false, pending: [] },
        );
        vi.stubGlobal("fetch", fetchMock);
        const onChange = vi.fn();
        const hook = renderHook(() =>
            useLearnFollowUps({
                recordingId: "rec-1",
                enabled: true,
                onChange,
            }),
        );
        await waitFor(() => expect(hook.result.current.held).toBe(true));

        act(() => hook.result.current.follow());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("stops waiting for a release another open run keeps back", async () => {
        const fetchMock = answering({ held: true, pending: [] });
        vi.stubGlobal("fetch", fetchMock);
        const hook = renderHook(() =>
            useLearnFollowUps({
                recordingId: "rec-1",
                enabled: true,
                onChange: vi.fn(),
            }),
        );
        await waitFor(() => expect(hook.result.current.held).toBe(true));

        act(() => hook.result.current.follow());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5 * 60_000);
        });

        // One on opening, then a bounded wait for the release.
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
    });

    it("follows jobs already queued when the page opens", async () => {
        const fetchMock = answering(
            { held: false, pending: ["title.generate"] },
            { held: false, pending: [] },
        );
        vi.stubGlobal("fetch", fetchMock);
        const onChange = vi.fn();
        renderHook(() =>
            useLearnFollowUps({
                recordingId: "rec-1",
                enabled: true,
                onChange,
            }),
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("asks nothing where Learn cannot hold anything back", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const hook = renderHook(() =>
            useLearnFollowUps({
                recordingId: "rec-1",
                enabled: false,
                onChange: vi.fn(),
            }),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(hook.result.current.held).toBe(false);
    });
});
