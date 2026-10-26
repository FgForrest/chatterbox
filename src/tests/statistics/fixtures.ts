import {
    METRICS,
    metricIndex,
    packRanking,
    type StatisticsData,
    type StatisticsScope,
} from "@/lib/statistics/data";

export function statisticsFixture(
    scope: StatisticsScope = "mine",
): StatisticsData {
    const daily = METRICS.map(() => Array<number>(365).fill(0));
    daily[metricIndex.minutes][364] = 90;
    daily[metricIndex.recordings][364] = 3;
    daily[metricIndex.startedRecordings][364] = 3;
    daily[metricIndex.plaud][364] = 90;
    daily[metricIndex.transcripts][364] = 4;
    daily[metricIndex.summaryCost][364] = 0.5;
    return {
        scope,
        tz: "UTC",
        start: "2025-10-27",
        days: 365,
        measuredFrom: null,
        daily,
        baseline: METRICS.map(() => 0),
        comparisonMinutes: Array<number>(365).fill(0),
        members: scope === "mine" ? [] : [["Jitka Dvořáková", true]],
        ranking:
            scope === "mine" ? [] : packRanking([[364, 0, 90, 2, 1, 0.5]], 1),
        models: [["Example provider", "example-model"]],
        modelDays: [[364, 0, 2, 1, 0.5, 0]],
        heat: [[364, 9, 3]],
        latency: [
            [364, 300, 1],
            [364, 600, 1],
        ],
    };
}
