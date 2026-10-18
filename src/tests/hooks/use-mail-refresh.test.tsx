// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh }),
}));

import { useMailRefresh } from "@/hooks/use-mail-refresh";

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
