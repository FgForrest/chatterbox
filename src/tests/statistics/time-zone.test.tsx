// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, expect, it, vi } from "vitest";
import { useStatisticsData } from "@/components/statistics/use-statistics-data";
import { statisticsFixture } from "./fixtures";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it.each([
    "Asia/Tokyo",
    "Etc/GMT+1",
])("keeps saved zone %s when the browser uses another zone", async (timeZone) => {
    const data = { ...statisticsFixture(), tz: timeZone };
    const fetchMock = vi
        .fn()
        .mockResolvedValue(Response.json(statisticsFixture()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useStatisticsData(data), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <IntlProvider locale="en" messages={{}} timeZone={timeZone}>
                {children}
            </IntlProvider>
        ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.tz).toBe(timeZone);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(
        Response.json({
            ...statisticsFixture("organization"),
            tz: timeZone,
        }),
    );
    await act(() => result.current.selectScope("organization"));
    expect(fetchMock).toHaveBeenCalledWith(
        `/api/statistics?scope=organization&tz=${encodeURIComponent(timeZone)}`,
    );
    expect(result.current.data.tz).toBe(timeZone);
});

it("refreshes aggregates when the resolved zone changes and reuses the original zone cache", async () => {
    let zone = "Asia/Tokyo";
    const data = { ...statisticsFixture(), tz: "Asia/Tokyo" };
    const fetchMock = vi
        .fn()
        .mockResolvedValue(Response.json({ ...data, tz: "Europe/Prague" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(() => useStatisticsData(data), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <IntlProvider locale="en" messages={{}} timeZone={zone}>
                {children}
            </IntlProvider>
        ),
    });
    zone = "Europe/Prague";
    rerender();
    await waitFor(() => expect(result.current.data.tz).toBe("Europe/Prague"));
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/statistics?scope=mine&tz=Europe%2FPrague",
    );
    zone = "Asia/Tokyo";
    rerender();
    await waitFor(() => expect(result.current.data.tz).toBe("Asia/Tokyo"));
    expect(fetchMock).toHaveBeenCalledOnce();
});
