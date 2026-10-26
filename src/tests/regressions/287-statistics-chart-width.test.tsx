// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeChart, useChartWidth } from "@/components/statistics/charts";
import { Waveform } from "@/components/statistics/interactive-charts";
import { statisticsFixture } from "@/tests/statistics/fixtures";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (message: string) => message,
}));

const observers: {
    emit: (width: number) => void;
    disconnect: ReturnType<typeof vi.fn>;
}[] = [];

beforeEach(() => {
    observers.length = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({ width: 876, height: 190 }),
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();
            constructor(callback: ResizeObserverCallback) {
                observers.push({
                    emit: (width) =>
                        callback(
                            [{ contentRect: { width } } as ResizeObserverEntry],
                            this as unknown as ResizeObserver,
                        ),
                    disconnect: this.disconnect,
                });
            }
            observe() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it("observes a ref attached after the component's initial effects", () => {
    function DeferredChart({ visible }: { visible: boolean }) {
        const { ref, width } = useChartWidth();
        return (
            <>
                {visible && <div ref={ref} />}
                <output>{width}</output>
            </>
        );
    }
    const { rerender } = render(<DeferredChart visible={false} />);
    expect(observers).toHaveLength(0);
    rerender(<DeferredChart visible />);
    expect(screen.getByRole("status").textContent).toBe("876");
    act(() => observers[0].emit(328));
    expect(screen.getByRole("status").textContent).toBe("328");
    rerender(<DeferredChart visible={false} />);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
});

it("fills the latency band only between consecutive observed buckets", () => {
    render(
        <TimeChart
            label="Time to summary"
            labels={["A", "B", "C", "D", "E", "F", "G"]}
            series={[
                {
                    label: "Median",
                    color: "red",
                    values: [null, null, 2, 3, null, 4, 5],
                },
                {
                    label: "90%",
                    color: "red",
                    values: [null, null, 4, 5, null, 6, 7],
                },
            ]}
            format={String}
            band
        />,
    );
    const chart = screen.getByRole("img");
    const fill =
        chart.querySelector('path[fill="red"]')?.getAttribute("d") ?? "";
    expect(fill.match(/M/g)).toHaveLength(2);
    expect(fill.match(/Z/g)).toHaveLength(2);
    const gridLine = chart.querySelector("line");
    const left = Number(gridLine?.getAttribute("x1"));
    const right = Number(gridLine?.getAttribute("x2"));
    const firstObservedX = left + (2 / 6) * (right - left);
    const coordinates = [...fill.matchAll(/[ML]([\d.]+),[\d.]+/g)];
    expect(coordinates).toHaveLength(8);
    expect(
        coordinates.every((match) => Number(match[1]) >= firstObservedX - 0.1),
    ).toBe(true);
});

describe.each([
    "chart",
    "waveform",
] as const)("statistics %s width (#287)", (kind) => {
    function Example({ visible = true }: { visible?: boolean }) {
        return visible ? (
            kind === "chart" ? (
                <TimeChart
                    label="Activity"
                    labels={["Monday", "Tuesday"]}
                    series={[
                        { label: "Recordings", color: "red", values: [1, 2] },
                    ]}
                    format={String}
                />
            ) : (
                <Waveform
                    data={statisticsFixture()}
                    range={{ start: 275, end: 364 }}
                    onRange={vi.fn()}
                    format={String}
                />
            )
        ) : null;
    }

    function width() {
        return Number(
            screen.getByRole("img").getAttribute("viewBox")?.split(" ")[2],
        );
    }

    it("measures on attachment before the observer's first notification", () => {
        render(<Example />);
        expect(width()).toBe(876);
    });

    it("retains a positive width during a zero-size layout and follows phone resizes", () => {
        render(<Example />);
        act(() => observers[0].emit(1206));
        expect(width()).toBe(1206);
        act(() => observers[0].emit(0));
        expect(width()).toBe(1206);
        act(() => observers[0].emit(328));
        expect(width()).toBe(328);
        act(() => observers[0].emit(200));
        expect(width()).toBe(200);
    });

    it("observes later mounts and disconnects on removal", () => {
        const { rerender } = render(<Example visible={false} />);
        expect(observers).toHaveLength(0);
        rerender(<Example />);
        act(() => observers[0].emit(574));
        expect(width()).toBe(574);
        rerender(<Example visible={false} />);
        expect(observers[0].disconnect).toHaveBeenCalledOnce();
        rerender(<Example />);
        act(() => observers[1].emit(328));
        expect(width()).toBe(328);
    });
});
