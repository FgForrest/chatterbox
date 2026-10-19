// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh }),
}));

import { useMailRefresh } from "@/hooks/use-mail-refresh";
import { useOrgEvents } from "@/hooks/use-org-events";

class MockEventSource {
    static instances: MockEventSource[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) {
        MockEventSource.instances.push(this);
    }
    open() {
        this.onopen?.();
    }
    fail() {
        this.onerror?.();
    }
    send(data: object) {
        this.onmessage?.({ data: JSON.stringify(data) });
    }
}

function source() {
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("missing EventSource");
    return instance;
}

async function advance(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
        await flush();
    });
}

function visible(value: "hidden" | "visible") {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value,
    });
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    visible("visible");
    refresh.mockReset();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("useMailRefresh", () => {
    it("refreshes when the newest accepted mail changes", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ version: "mail-1" }))
            .mockResolvedValueOnce(Response.json({ version: "mail-2" }));
        vi.stubGlobal("fetch", fetchMock);

        renderHook(() => useMailRefresh(true));
        await act(flush);
        expect(refresh).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(60_000);
            await flush();
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        await advance(300);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not refresh while the mail token stays the same", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(() =>
                Promise.resolve(Response.json({ version: "mail-1" })),
            );
        vi.stubGlobal("fetch", fetchMock);

        renderHook(() => useMailRefresh(true));
        await act(flush);
        await act(async () => {
            vi.advanceTimersByTime(60_000);
            await flush();
        });
        await act(async () => {
            vi.advanceTimersByTime(60_000);
            await flush();
        });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("does not check or refresh while the tab is hidden", async () => {
        visible("hidden");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        renderHook(() => useMailRefresh(true));
        await act(async () => {
            vi.advanceTimersByTime(180_000);
            document.dispatchEvent(new Event("visibilitychange"));
            await flush();
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });
});

describe("shared push stream", () => {
    beforeEach(() => {
        vi.stubGlobal("EventSource", MockEventSource);
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockImplementation(() =>
                    Promise.resolve(Response.json({ version: "v1" })),
                ),
        );
    });

    it("shares one source across mail and multiple org subscribers until the last unmount", async () => {
        const first = vi.fn();
        const second = vi.fn();
        const mail = renderHook(() => useMailRefresh(true));
        const orgA = renderHook(() => useOrgEvents(true, first));
        const orgB = renderHook(() => useOrgEvents(true, second));
        await act(flush);
        expect(MockEventSource.instances).toHaveLength(1);
        expect(source().url).toBe("/api/events");
        act(() => source().send({ type: "tree" }));
        expect(first).toHaveBeenCalledWith({ type: "tree" });
        expect(second).toHaveBeenCalledWith({ type: "tree" });
        mail.unmount();
        orgA.unmount();
        expect(source().close).not.toHaveBeenCalled();
        orgB.unmount();
        expect(source().close).toHaveBeenCalledTimes(1);
    });

    it("debounces a burst of mail events without sending them to org handlers", async () => {
        const org = vi.fn();
        renderHook(() => {
            useMailRefresh(true);
            useOrgEvents(true, org);
        });
        await act(flush);
        act(() => {
            source().send({ type: "mail" });
            source().send({ type: "mail" });
        });
        await advance(299);
        expect(refresh).not.toHaveBeenCalled();
        await advance(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(org).not.toHaveBeenCalled();
    });

    it("remembers hidden mail and checks status immediately on visibility return", async () => {
        renderHook(() => useMailRefresh(true));
        await act(flush);
        visible("hidden");
        act(() => source().send({ type: "mail" }));
        await advance(1000);
        expect(refresh).not.toHaveBeenCalled();
        visible("visible");
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
            await flush();
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        await advance(300);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("defers an already scheduled refresh when the tab becomes hidden", async () => {
        renderHook(() => useMailRefresh(true));
        await act(flush);
        act(() => source().send({ type: "mail" }));
        visible("hidden");
        await advance(300);
        expect(refresh).not.toHaveBeenCalled();
        visible("visible");
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        await advance(300);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("checks once on each reconnect and polls slowly while connected", async () => {
        renderHook(() => useMailRefresh(true));
        await act(flush);
        await act(async () => {
            source().open();
            await flush();
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        await advance(60_000);
        expect(fetch).toHaveBeenCalledTimes(2);
        await advance(240_000);
        expect(fetch).toHaveBeenCalledTimes(3);
        await act(async () => {
            source().fail();
            source().open();
            await flush();
        });
        expect(fetch).toHaveBeenCalledTimes(4);
    });

    it("polls every minute while connecting or repeatedly failing", async () => {
        renderHook(() => useMailRefresh(true));
        await act(flush);
        await advance(60_000);
        expect(fetch).toHaveBeenCalledTimes(2);
        for (let attempt = 0; attempt < 20; attempt++) {
            act(() => source().fail());
            await advance(3_000);
        }
        expect(fetch).toHaveBeenCalledTimes(3);
        act(() => source().fail());
        await advance(60_000);
        expect(fetch).toHaveBeenCalledTimes(4);
    });

    it("recovers a missed mail event through the reconnect status check", async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(Response.json({ version: "old" }))
            .mockResolvedValueOnce(Response.json({ version: "new" }));
        renderHook(() => useMailRefresh(true));
        await act(flush);
        await act(async () => {
            source().open();
            await flush();
        });
        await advance(300);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("keeps polling when constructing EventSource throws", async () => {
        vi.stubGlobal(
            "EventSource",
            class {
                constructor() {
                    throw new Error("blocked");
                }
            },
        );
        renderHook(() => useMailRefresh(true));
        await act(flush);
        await advance(60_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("drops malformed and identifying client frames", async () => {
        const org = vi.fn();
        renderHook(() => {
            useMailRefresh(true);
            useOrgEvents(true, org);
        });
        await act(flush);
        act(() => {
            source().send({ type: "mail", userId: "someone-else" });
            source().onmessage?.({ data: "null" });
            source().onmessage?.({ data: "{" });
            source().send({ type: "recording", recordingId: 1 });
        });
        await advance(300);
        expect(org).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("stays inactive when mail is disabled while org continues", async () => {
        const org = vi.fn();
        renderHook(() => {
            useMailRefresh(false);
            useOrgEvents(true, org);
        });
        act(() => source().send({ type: "tree" }));
        await advance(300_000);
        expect(org).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("handles failed status requests and cancels pending work on unmount", async () => {
        vi.mocked(fetch).mockRejectedValue(new Error("offline"));
        const hook = renderHook(() => useMailRefresh(true));
        await act(flush);
        act(() => source().send({ type: "mail" }));
        hook.unmount();
        await advance(300_000);
        expect(refresh).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
