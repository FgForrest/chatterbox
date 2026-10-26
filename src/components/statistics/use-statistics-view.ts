"use client";

import { useLocale } from "next-intl";
import {
    bucketize,
    type DayRange,
    type Metric,
    metricIndex,
    type StatisticsData,
    shiftDay,
    sum,
} from "@/lib/statistics/data";
import type { ChartSeries } from "./charts";

export type StatisticsView = ReturnType<typeof useStatisticsView>;

export function useStatisticsView(data: StatisticsData, range: DayRange) {
    const locale = useLocale();
    const number = (value: number) =>
        new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
            value,
        );
    const count = (value: number) =>
        new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
            value,
        );
    const usd = (value: number) =>
        new Intl.NumberFormat(locale, {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 2,
        }).format(value);
    const minutes = (value: number) => {
        const rounded = Math.round(value);
        return rounded >= 60
            ? `${count(Math.floor(rounded / 60))} h ${count(rounded % 60)} min`
            : `${count(rounded)} min`;
    };
    const bytes = (value: number) =>
        value >= 1024 ** 3
            ? `${number(value / 1024 ** 3)} GB`
            : `${number(value / 1024 ** 2)} MB`;
    const percent = (value: number) =>
        new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 0,
        }).format(value);
    const date = (index: number) =>
        new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "numeric",
            timeZone: "UTC",
        }).format(new Date(`${shiftDay(data.start, index)}T00:00:00Z`));
    const buckets = bucketize(range);
    const labels = buckets.map((bucket) =>
        bucket.start === bucket.end
            ? date(bucket.start)
            : `${date(bucket.start)} – ${date(bucket.end)}`,
    );
    const values = (metric: Metric) => data.daily[metricIndex[metric]];
    const total = (metric: Metric) => sum(values(metric), range);
    const atEnd = (metric: Metric) => values(metric)[range.end];
    const beforeRange = (metric: Metric) =>
        range.start
            ? values(metric)[range.start - 1]
            : data.baseline[metricIndex[metric]];
    const per = (metric: Metric) =>
        buckets.map((bucket) => sum(values(metric), bucket));
    const cumulative = (metric: Metric) =>
        buckets.map((bucket) => values(metric)[bucket.end]);
    const series = (
        label: string,
        metric: Metric,
        color: string,
        running = false,
    ): ChartSeries => ({
        label,
        color,
        values: running ? cumulative(metric) : per(metric),
    });
    return {
        data,
        range,
        locale,
        number,
        count,
        usd,
        minutes,
        bytes,
        percent,
        date,
        buckets,
        labels,
        total,
        atEnd,
        beforeRange,
        cumulative,
        series,
    };
}
