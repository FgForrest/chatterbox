"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import {
    Figures,
    INK,
    Legend,
    Panel,
    SERIES,
    Segmented,
    TimeChart,
} from "./charts";
import { type RankedRow, RankedRows } from "./interactive-charts";
import styles from "./statistics.module.css";
import type { StatisticsView } from "./use-statistics-view";

function useCostSteps() {
    const i18n = useExtracted();
    const steps = [
        {
            label: i18n("Transcription"),
            metric: "transcriptionCost" as const,
            color: SERIES[0],
        },
        {
            label: i18n("Learning"),
            metric: "learnCost" as const,
            color: SERIES[1],
        },
        {
            label: i18n("Summary"),
            metric: "summaryCost" as const,
            color: SERIES[2],
        },
        {
            label: i18n("Topics"),
            metric: "topicsCost" as const,
            color: SERIES[3],
        },
        {
            label: i18n("Titles"),
            metric: "titleCost" as const,
            color: SERIES[4],
        },
        {
            label: i18n("Other"),
            metric: "otherCost" as const,
            color: "var(--muted-foreground)",
        },
    ];
    return steps;
}

export function SpendSection({ view }: { view: StatisticsView }) {
    const i18n = useExtracted();
    const { count, usd, percent, total, labels, series } = view;
    const minutesTotal = total("minutes");
    const steps = useCostSteps();
    const cost = steps.reduce((result, step) => result + total(step.metric), 0);
    const topStep = [...steps].sort(
        (a, b) => total(b.metric) - total(a.metric),
    )[0];
    const costSeries = steps
        .filter((step, i) => i < 5 || total(step.metric) > 0)
        .map((step) => series(step.label, step.metric, step.color));

    return (
        <Panel
            title={i18n("AI spend")}
            subtitle={i18n("Estimated from each provider's price list.")}
            figures={
                <Figures
                    items={[
                        { label: i18n("Total"), value: usd(cost) },
                        {
                            label: i18n("Per recorded hour"),
                            value: minutesTotal
                                ? usd(
                                      Math.max(0, cost - total("mailCost")) /
                                          (minutesTotal / 60),
                                  )
                                : "–",
                        },
                        {
                            label: i18n("Most expensive step"),
                            value: cost
                                ? `${topStep.label} ${percent(total(topStep.metric) / cost)}`
                                : "–",
                        },
                    ]}
                />
            }
        >
            <Legend series={costSeries} />
            <TimeChart
                label={i18n("AI spend by step")}
                labels={labels}
                series={costSeries}
                format={usd}
                columns
            />
            <p className={styles.sub}>
                {i18n(
                    "For Claude Code and Codex, this estimates the equivalent API cost, not the subscription payment.",
                )}
            </p>
            {total("unpriced") > 0 && (
                <p className={styles.hint}>
                    {i18n(
                        "{count} requests have no known price and are excluded from spend.",
                        { count: count(total("unpriced")) },
                    )}
                </p>
            )}
        </Panel>
    );
}

export function StorageSection({ view }: { view: StatisticsView }) {
    const i18n = useExtracted();
    const {
        data,
        locale,
        buckets,
        bytes,
        labels,
        atEnd,
        beforeRange,
        cumulative,
    } = view;
    const audio = cumulative("audioBytes");
    const mailBytes = cumulative("mailBytes");
    const measuredDay = data.measuredFrom
        ? Math.round(
              (Date.parse(data.measuredFrom) - Date.parse(data.start)) /
                  86_400_000,
          )
        : data.days;
    const firstMeasuredBucket = buckets.findIndex(
        (bucket) => bucket.end >= measuredDay,
    );
    const estimatedUntil =
        firstMeasuredBucket < 0 ? buckets.length : firstMeasuredBucket;
    const measuredDate = data.measuredFrom
        ? new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeZone: "UTC",
          }).format(new Date(`${data.measuredFrom}T00:00:00Z`))
        : null;
    const diskSeries = [
        {
            label: i18n("Audio"),
            color: SERIES[0],
            values: audio,
            estimatedUntil,
            area: true,
        },
        {
            label: i18n("Mail and attachments"),
            color: SERIES[1],
            values: audio.map((value, i) => value + mailBytes[i]),
            base: audio,
            raw: mailBytes,
            estimatedUntil,
        },
    ];

    return (
        <Panel
            title={i18n("Disk space")}
            subtitle={
                measuredDate
                    ? i18n("Measured since {date}", {
                          date: measuredDate,
                      })
                    : undefined
            }
            wide
            figures={
                <Figures
                    items={[
                        {
                            label: i18n("Used"),
                            value: bytes(
                                atEnd("audioBytes") + atEnd("mailBytes"),
                            ),
                        },
                        {
                            label: i18n("Change over period"),
                            value: bytes(
                                atEnd("audioBytes") +
                                    atEnd("mailBytes") -
                                    beforeRange("audioBytes") -
                                    beforeRange("mailBytes"),
                            ),
                        },
                    ]}
                />
            }
        >
            <Legend
                series={[
                    ...diskSeries,
                    ...(estimatedUntil > 0
                        ? [
                              {
                                  label: i18n("estimated"),
                                  color: INK,
                                  dashed: true,
                              },
                          ]
                        : []),
                ]}
            />
            <TimeChart
                label={i18n("Disk space over time")}
                labels={labels}
                series={diskSeries}
                format={bytes}
            />
            <p className={styles.sub}>
                {i18n(
                    "Solid lines use daily UTC storage measurements, carried forward between runs. Dashed lines estimate earlier usage from retained metadata. Sidecars, waveforms and exports are not included.",
                )}
            </p>
        </Panel>
    );
}

export function ModelsSection({ view }: { view: StatisticsView }) {
    const i18n = useExtracted();
    const { data, range, count, usd } = view;
    const [modelsBy, setModelsBy] = useState<"cost" | "jobs">("cost");
    const steps = useCostSteps();
    const modelGroups = data.models.map(([provider, model], index) => ({
        provider,
        model,
        index,
        parts: steps.map(() => ({ cost: 0, jobs: 0, unknown: 0 })),
    }));
    for (const [day, model, step, jobs, modelCost, unknown] of data.modelDays) {
        if (day < range.start || day > range.end) continue;
        const part = modelGroups[model].parts[step];
        part.cost += modelCost;
        part.jobs += jobs;
        part.unknown += unknown;
    }
    const modelRows: RankedRow[] = modelGroups
        .filter((group) => group.parts.some((part) => part.jobs))
        .map((group) => {
            const jobs = group.parts.reduce((acc, part) => acc + part.jobs, 0);
            const spend = group.parts.reduce((acc, part) => acc + part.cost, 0);
            const unknown = group.parts.reduce(
                (acc, part) => acc + part.unknown,
                0,
            );
            let formatted: string;
            if (modelsBy === "jobs") formatted = count(jobs);
            else if (spend) formatted = usd(spend);
            else if (unknown) formatted = i18n("Unpriced");
            else formatted = i18n("free");
            return {
                key: String(group.index),
                name: group.model,
                subtitle: group.provider,
                value: modelsBy === "cost" ? spend : jobs,
                formatted,
                parts: group.parts.map((part, i) => ({
                    label: steps[i].label,
                    color: steps[i].color,
                    value: modelsBy === "cost" ? part.cost : part.jobs,
                    detail: `${usd(part.cost)} · ${i18n("{count} jobs", { count: count(part.jobs) })}${part.unknown ? ` · ${i18n("{count} unpriced", { count: count(part.unknown) })}` : ""}`,
                })),
            };
        })
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    return (
        <Panel
            title={i18n("Models")}
            subtitle={i18n("Which model did what.")}
            controls={
                <Segmented
                    label={i18n("Sort models")}
                    options={[
                        {
                            value: "cost" as const,
                            label: i18n("By cost"),
                        },
                        {
                            value: "jobs" as const,
                            label: i18n("By jobs"),
                        },
                    ]}
                    value={modelsBy}
                    onChange={setModelsBy}
                />
            }
        >
            <Legend series={steps} />
            <RankedRows label={i18n("Models")} rows={modelRows} />
        </Panel>
    );
}
