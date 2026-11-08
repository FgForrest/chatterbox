// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgenda } from "@/components/meetings/use-agenda";
import { detail } from "../meetings/ui-fixtures";

vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));

const sources: Source[] = [];
class Source {
    onmessage: (() => void) | null = null;
    onerror: (() => void) | null = null;
    connected: (() => void) | undefined;
    close = vi.fn();
    constructor(url: string) {
        if (url === "/api/meetings/agenda/events") sources.push(this);
    }
    addEventListener(type: string, listener: () => void) {
        if (type === "connected") this.connected = listener;
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    sources.length = 0;
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ unchanged: true, version: 1 })),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each([
    true,
    false,
])("closes stream errors, caps exponential backoff and keeps polling with pollEnabled=%s", async (pollEnabled) => {
    renderHook(() =>
        useAgenda(
            "agenda",
            detail({ cursor: "1:standalone:idle" }),
            true,
            pollEnabled,
        ),
    );
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        const source = sources[sources.length - 1];
        const count = sources.length;
        act(() => source.onerror?.());
        expect(source.close).toHaveBeenCalledOnce();
        act(() => source.onerror?.());
        expect(source.close).toHaveBeenCalledOnce();
        await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
        expect(sources).toHaveLength(count);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(sources).toHaveLength(count + 1);
    }
    expect(fetch).toHaveBeenCalledTimes(pollEnabled ? 12 : 3);
    expect(fetch).toHaveBeenLastCalledWith(
        "/api/meetings/agenda?since=1%3Astandalone%3Aidle",
        expect.objectContaining({ method: "GET" }),
    );
    const ready = sources[sources.length - 1];
    await act(async () => ready.connected?.());
    expect(fetch).toHaveBeenCalledTimes(pollEnabled ? 13 : 4);
    act(() => ready.onerror?.());
    const count = sources.length;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(sources).toHaveLength(count + 1);
});

it("cancels pending reconnects on deactivation and unmount", async () => {
    const initial = detail();
    const { rerender, unmount } = renderHook(
        ({ active }) => useAgenda("agenda", initial, active),
        { initialProps: { active: true } },
    );
    act(() => sources[0].onerror?.());
    rerender({ active: false });
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(sources).toHaveLength(1);
    expect(sources[0].close).toHaveBeenCalledOnce();
    rerender({ active: true });
    expect(sources).toHaveLength(2);
    act(() => sources[1].onerror?.());
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(sources).toHaveLength(2);
    expect(sources[1].close).toHaveBeenCalledOnce();
});
