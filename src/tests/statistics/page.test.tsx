// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Waveform } from "@/components/statistics/interactive-charts";
import { StatisticsPage } from "@/components/statistics/statistics-page";
import { useStatisticsView } from "@/components/statistics/use-statistics-view";
import { metricIndex } from "@/lib/statistics/data";
import { statisticsFixture } from "./fixtures";

const unitLabels = vi.hoisted(() => ({}) as Record<string, string>);

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () =>
        (text: string | { message: string }, values?: Record<string, string>) =>
            Object.entries(values ?? {}).reduce(
                (result, [key, value]) => result.replace(`{${key}}`, value),
                unitLabels[typeof text === "string" ? text : text.message] ??
                    (typeof text === "string" ? text : text.message),
            ),
}));
vi.mock("@/components/product-name-provider", () => ({
    useProductName: () => "Chatterbox",
}));

const fetchMock = vi.fn();
beforeEach(() => {
    for (const key of Object.keys(unitLabels)) delete unitLabels[key];
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("statistics page", () => {
    it("uses translated duration units in the hero and rounds chart durations across the hour boundary", () => {
        unitLabels.h = "hours";
        unitLabels.min = "minutes";
        const data = statisticsFixture();
        const { result } = renderHook(() =>
            useStatisticsView(data, { start: 0, end: 364 }),
        );
        expect(result.current.minutes(59.4)).toBe("59 minutes");
        expect(result.current.minutes(59.5)).toBe("1 hours 0 minutes");
        expect(result.current.minutes(125)).toBe("2 hours 5 minutes");
        render(<StatisticsPage initialData={data} scopes={["mine"]} />);
        const panel = screen.getByRole("region", { name: "Recorded time" });
        expect(
            within(panel).getByText("hours", { selector: "small" }),
        ).toBeTruthy();
        expect(
            within(panel).getByText("minutes", { selector: "small" }),
        ).toBeTruthy();
    });
    it("averages start-day minutes by start-day counts when older recordings are imported later", () => {
        const data = statisticsFixture();
        data.daily[metricIndex.minutes].fill(0);
        data.daily[metricIndex.startedRecordings].fill(0);
        data.daily[metricIndex.recordings].fill(0);
        data.daily[metricIndex.minutes][0] = 120;
        data.daily[metricIndex.startedRecordings][0] = 1;
        data.daily[metricIndex.minutes][364] = 60;
        data.daily[metricIndex.startedRecordings][364] = 1;
        data.daily[metricIndex.recordings][364] = 2;
        render(<StatisticsPage initialData={data} scopes={["mine"]} />);
        fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
        const panel = screen.getByRole("region", { name: "Recorded time" });
        expect(
            within(panel).getByText("1 recordings, averaging 60 min"),
        ).toBeTruthy();
        const activity = screen.getByRole("region", {
            name: "Recordings, transcripts and summaries",
        });
        expect(
            within(activity).getByText("2", { selector: "dd" }),
        ).toBeTruthy();
    });
    it.each([
        ["forward", "Home", "ArrowRight", false, { start: 1, end: 14 }],
        ["backward", "End", "ArrowLeft", false, { start: 351, end: 364 }],
        ["Shift forward", "Home", "ArrowRight", true, { start: 1, end: 14 }],
        ["Shift backward", "End", "ArrowLeft", true, { start: 351, end: 364 }],
    ] as const)("keeps both bucket endpoints when brushing %s", (_name, initial, direction, shiftKey, expected) => {
        const onRange = vi.fn();
        render(
            <Waveform
                data={statisticsFixture()}
                range={{ start: 275, end: 364 }}
                onRange={onRange}
                format={String}
            />,
        );
        const wave = screen.getByRole("img");
        fireEvent.focus(wave);
        fireEvent.keyDown(wave, { key: initial });
        if (initial === "Home") fireEvent.keyDown(wave, { key: "ArrowRight" });
        if (!shiftKey) fireEvent.keyDown(wave, { key: "Enter" });
        fireEvent.keyDown(wave, { key: direction, shiftKey });
        if (!shiftKey) fireEvent.keyDown(wave, { key: "Enter" });
        expect(onRange).toHaveBeenLastCalledWith(expected);
    });
    it.each([
        "hosted",
        "local",
    ])("hides scope selection in %s mode and uses SSR without a fetch", () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine"]}
            />,
        );
        expect(screen.queryByRole("group", { name: "Whose data" })).toBeNull();
        expect(screen.queryByRole("radio", { name: "Everyone" })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("shows the Mine ranking empty state", () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine", "organization", "everyone"]}
            />,
        );
        expect(
            screen.getByText(
                "The people ranking is available in Organization and Everyone.",
            ),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Show Organization" }),
        ).toBeTruthy();
    });
    it("opens a chart's table with the same bucket values", async () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine"]}
            />,
        );
        const chart = screen.getByRole("region", {
            name: "Recordings, transcripts and summaries",
        });
        const details = within(chart)
            .getByText("Show as a table")
            .closest("details");
        if (!details) throw new Error("Table details missing");
        fireEvent.click(details.querySelector("summary") as HTMLElement);
        await waitFor(() =>
            expect(within(chart).getByRole("table")).toBeTruthy(),
        );
        const table = within(chart).getByRole("table");
        expect(within(table).getAllByRole("row")).toHaveLength(14);
        expect(within(table).getAllByRole("cell").at(-3)?.textContent).toBe(
            "3",
        );
    });
    it("shows a tooltip immediately on keyboard focus and moves through buckets", () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine"]}
            />,
        );
        const chart = screen.getByRole("img", {
            name: "Recordings, transcripts and summaries over time",
        });
        fireEvent.focus(chart);
        expect(screen.getByRole("tooltip").textContent).toContain(
            "3Recordings",
        );
        fireEvent.keyDown(chart, { key: "Home" });
        expect(screen.getByRole("tooltip").textContent).toContain(
            "0Recordings",
        );
        fireEvent.keyDown(chart, { key: "Escape" });
        expect(screen.queryByRole("tooltip")).toBeNull();
    });
    it("changes every range locally without requests", () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine"]}
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
        expect(
            (screen.getByRole("radio", { name: "30 days" }) as HTMLInputElement)
                .checked,
        ).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("prefetches a scope once and uses it on selection", async () => {
        fetchMock.mockResolvedValue(
            Response.json(statisticsFixture("organization")),
        );
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine", "organization", "everyone"]}
            />,
        );
        const organization = screen.getByRole("radio", {
            name: "Organization",
        });
        fireEvent.pointerEnter(
            organization.closest("label") as HTMLLabelElement,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fireEvent.click(organization);
        await waitFor(() =>
            expect(
                screen.queryByText(
                    "The people ranking is available in Organization and Everyone.",
                ),
            ).toBeNull(),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Jitka Dvořáková")).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: "Mine" }));
        await waitFor(() =>
            expect(
                screen.getByText(
                    "The people ranking is available in Organization and Everyone.",
                ),
            ).toBeTruthy(),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it("keeps the previous frame while loading and recovers from a failed scope", async () => {
        let finish: (response: Response) => void = () => undefined;
        fetchMock.mockReturnValue(
            new Promise<Response>((resolve) => {
                finish = resolve;
            }),
        );
        const { container } = render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine", "organization", "everyone"]}
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: "Everyone" }));
        expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
        expect(
            screen.getByText(
                "The people ranking is available in Organization and Everyone.",
            ),
        ).toBeTruthy();
        await act(async () => finish(Response.json({}, { status: 403 })));
        expect(screen.getByRole("alert").textContent).toContain(
            "previous view",
        );
        fetchMock.mockResolvedValue(
            Response.json(statisticsFixture("everyone")),
        );
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
    it("ignores an older response after switching scope again", async () => {
        let finish: (response: Response) => void = () => undefined;
        fetchMock.mockReturnValue(
            new Promise<Response>((resolve) => {
                finish = resolve;
            }),
        );
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine", "organization", "everyone"]}
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: "Everyone" }));
        fireEvent.click(screen.getByRole("radio", { name: "Mine" }));
        await act(async () => undefined);
        await act(async () =>
            finish(Response.json(statisticsFixture("everyone"))),
        );
        expect(
            screen.getByText(
                "The people ranking is available in Organization and Everyone.",
            ),
        ).toBeTruthy();
    });
    it("refetches only when the browser timezone differs from SSR", async () => {
        const data = statisticsFixture();
        data.tz = "Europe/Prague";
        fetchMock.mockResolvedValue(Response.json(statisticsFixture()));
        render(<StatisticsPage initialData={data} scopes={["mine"]} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls[0][0]).toContain("tz=UTC");
        expect(document.cookie).toContain("tz=UTC");
    });
    it("uses keyboard selection on the waveform and clears the preset", () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture()}
                scopes={["mine"]}
            />,
        );
        const wave = screen.getByRole("img", {
            name: "Recorded time by day over the last year; the selected range is highlighted",
        });
        fireEvent.focus(wave);
        expect(screen.getByRole("tooltip")).toBeTruthy();
        fireEvent.keyDown(wave, { key: "Enter" });
        fireEvent.keyDown(wave, { key: "ArrowLeft" });
        fireEvent.keyDown(wave, { key: "Enter" });
        expect(
            (screen.getByRole("radio", { name: "90 days" }) as HTMLInputElement)
                .checked,
        ).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("shows model and heatmap tooltips on keyboard focus", () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture("organization")}
                scopes={["mine", "organization", "everyone"]}
            />,
        );
        const model = screen.getByRole("button", { name: /example-model/ });
        fireEvent.focus(model);
        expect(screen.getByRole("tooltip").textContent).toContain("Summary");
        fireEvent.blur(model);
        const heat = screen.getByRole("button", { name: "Mon 9:00–10:00: 3" });
        fireEvent.focus(heat);
        expect(screen.getByRole("tooltip").textContent).toContain(
            "3Recordings",
        );
    });
    it("shows missing summary latency as absent rather than zero", () => {
        const data = statisticsFixture();
        data.latency = [];
        render(<StatisticsPage initialData={data} scopes={["mine"]} />);
        const section = screen.getByRole("region", {
            name: "How quickly summaries are ready",
        });
        expect(within(section).getAllByText("–")).toHaveLength(3);
        const chart = within(section).getByRole("img");
        expect(
            [...chart.querySelectorAll("path")].some(
                (path) => path.getAttribute("d") === "Z",
            ),
        ).toBe(false);
    });
    it("distinguishes measured and estimated storage across ranges", () => {
        const data = statisticsFixture();
        data.measuredFrom = "2026-10-01";
        render(<StatisticsPage initialData={data} scopes={["mine"]} />);
        const panel = screen.getByRole("region", { name: "Disk space" });
        expect(
            within(panel).getByText("Measured since Oct 1, 2026"),
        ).toBeTruthy();
        const chart = within(panel).getByRole("img");
        expect(
            chart.querySelectorAll('path[stroke-dasharray="3 4"]'),
        ).toHaveLength(2);
        expect(
            chart.querySelectorAll("path[stroke]:not([stroke-dasharray])"),
        ).toHaveLength(2);
        fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
        expect(
            chart.querySelectorAll('path[stroke-dasharray="3 4"]'),
        ).toHaveLength(2);
    });
    it("draws wholly measured storage without an estimate legend", () => {
        const data = statisticsFixture();
        data.measuredFrom = "2025-01-01";
        render(<StatisticsPage initialData={data} scopes={["mine"]} />);
        const panel = screen.getByRole("region", { name: "Disk space" });
        expect(within(panel).queryByText("estimated")).toBeNull();
        expect(
            within(panel)
                .getByRole("img")
                .querySelectorAll("path[stroke-dasharray]"),
        ).toHaveLength(0);
    });
    it("offers table views for models, people and the heatmap too", async () => {
        render(
            <StatisticsPage
                initialData={statisticsFixture("everyone")}
                scopes={["mine", "organization", "everyone"]}
            />,
        );
        for (const title of [
            "Models",
            "Who uses Chatterbox the most",
            "When people talk",
        ]) {
            const section = screen.getByRole("region", { name: title });
            const details = within(section)
                .getByText("Show as a table")
                .closest("details");
            if (!details) throw new Error("Missing details");
            fireEvent.click(details.querySelector("summary") as HTMLElement);
            await waitFor(() =>
                expect(within(section).getByRole("table")).toBeTruthy(),
            );
        }
    });
});
