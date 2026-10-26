"use client";

import { Users } from "lucide-react";
import { useExtracted } from "next-intl";
import { useMemo, useState } from "react";
import { useProductName } from "@/components/product-name-provider";
import {
    latencyPercentile,
    type StatisticsScope,
    unpackRanking,
} from "@/lib/statistics/data";
import {
    type ChartSeries,
    Figures,
    Legend,
    Panel,
    SERIES,
    Segmented,
    TimeChart,
} from "./charts";
import { Heatmap, type RankedRow, RankedRows } from "./interactive-charts";
import styles from "./statistics.module.css";
import type { StatisticsView } from "./use-statistics-view";

export function PeopleSection({
    view,
    scopes,
    selectScope,
}: {
    view: StatisticsView;
    scopes: StatisticsScope[];
    selectScope: (scope: StatisticsScope) => Promise<void>;
}) {
    const i18n = useExtracted();
    const accusativeName = useProductName("accusative");
    const { data, range, minutes, usd, count } = view;
    const ranking = useMemo(() => unpackRanking(data.ranking), [data.ranking]);
    const [peopleBy, setPeopleBy] = useState<
        "minutes" | "mail" | "resolved" | "cost"
    >("minutes");
    const memberTotals = data.members.map(() => [0, 0, 0, 0]);
    for (const [day, member, recorded, mail, resolved, spend] of ranking) {
        if (day < range.start || day > range.end) continue;
        const row = memberTotals[member];
        row[0] += recorded;
        row[1] += mail;
        row[2] += resolved;
        row[3] += spend;
    }
    const peopleFields = [
        i18n("Recorded time"),
        i18n("Mail"),
        i18n("Tasks resolved"),
        i18n("Spend"),
    ];
    const peopleIndex = { minutes: 0, mail: 1, resolved: 2, cost: 3 }[peopleBy];
    function formatPerson(value: number, index: number) {
        if (index === 0) return minutes(value);
        if (index === 3) return usd(value);
        return count(value);
    }
    const peopleRows: RankedRow[] = data.members
        .map(([memberName, you], i) => ({
            key: String(i),
            name: memberName ?? i18n("Member"),
            you,
            value: memberTotals[i][peopleIndex],
            formatted: formatPerson(memberTotals[i][peopleIndex], peopleIndex),
            parts: peopleFields.map((label, index) => ({
                label,
                color: you ? "var(--primary)" : "var(--muted-foreground)",
                value: index === peopleIndex ? memberTotals[i][index] : 0,
                detail: formatPerson(memberTotals[i][index], index),
            })),
        }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    return (
        <Panel
            title={i18n("Who uses {name} the most", {
                name: accusativeName,
            })}
            controls={
                data.scope !== "mine" && (
                    <Segmented
                        label={i18n("Sort people")}
                        options={[
                            {
                                value: "minutes" as const,
                                label: peopleFields[0],
                            },
                            {
                                value: "mail" as const,
                                label: peopleFields[1],
                            },
                            {
                                value: "resolved" as const,
                                label: peopleFields[2],
                            },
                            {
                                value: "cost" as const,
                                label: peopleFields[3],
                            },
                        ]}
                        value={peopleBy}
                        onChange={setPeopleBy}
                    />
                )
            }
        >
            {data.scope === "mine" ? (
                <div className={styles.empty}>
                    <p>
                        {i18n(
                            "The people ranking is available in Organization and Everyone.",
                        )}
                    </p>
                    {scopes.includes("organization") && (
                        <button
                            type="button"
                            className={styles.orgChip}
                            onClick={() => {
                                void selectScope("organization");
                            }}
                        >
                            <Users
                                className="text-organization"
                                aria-hidden="true"
                            />
                            {i18n("Show Organization")}
                        </button>
                    )}
                </div>
            ) : (
                <RankedRows
                    label={i18n("People ranking")}
                    rows={peopleRows}
                    numbered
                />
            )}
        </Panel>
    );
}

export function KnowledgeSections({ view }: { view: StatisticsView }) {
    const i18n = useExtracted();
    const name = useProductName();
    const {
        data,
        range,
        buckets,
        labels,
        count,
        minutes,
        total,
        atEnd,
        beforeRange,
        series,
    } = view;
    const almanacSeries = [
        series(i18n("People"), "people", SERIES[3], true),
        series(i18n("Companies and projects"), "entities", SERIES[1], true),
        series(
            i18n({ id: "statistics_almanacTerms", message: "Terms" }),
            "terms",
            SERIES[4],
            true,
        ),
        series(i18n("Aliases"), "aliases", SERIES[2], true),
    ];
    const latencySeries: ChartSeries[] = [
        {
            label: i18n("Median"),
            color: SERIES[2],
            values: buckets.map((bucket) =>
                latencyPercentile(data.latency, bucket, 0.5),
            ),
        },
        {
            label: i18n("90% of summaries ready within"),
            color: SERIES[2],
            values: buckets.map((bucket) =>
                latencyPercentile(data.latency, bucket, 0.9),
            ),
        },
    ];
    const medianLatency = latencyPercentile(data.latency, range, 0.5);
    const tailLatency = latencyPercentile(data.latency, range, 0.9);
    const measuredLatencies = latencySeries[0].values.filter(
        (value): value is number => value !== null,
    );

    return (
        <>
            <Panel title={i18n("When people talk")}>
                <Heatmap data={data} range={range} />
            </Panel>
            <Panel
                title={i18n("What {name} has learned", { name })}
                subtitle={i18n("Total entries in the Almanac.")}
                figures={
                    <Figures
                        items={[
                            {
                                label: i18n("People"),
                                value: `+${count(atEnd("people") - beforeRange("people"))}`,
                            },
                            {
                                label: i18n("Companies and projects"),
                                value: `+${count(atEnd("entities") - beforeRange("entities"))}`,
                            },
                            {
                                label: i18n({
                                    id: "statistics_almanacTerms",
                                    message: "Terms",
                                }),
                                value: `+${count(atEnd("terms") - beforeRange("terms"))}`,
                            },
                            {
                                label: i18n("Mishearings fixed"),
                                value: count(total("corrections")),
                            },
                        ]}
                    />
                }
            >
                <Legend series={almanacSeries} />
                <TimeChart
                    label={i18n("Almanac growth")}
                    labels={labels}
                    series={almanacSeries}
                    format={count}
                    minimumStep={1}
                />
            </Panel>
            <Panel
                title={i18n("How quickly summaries are ready")}
                subtitle={i18n(
                    "From the end of a recording to its first summary.",
                )}
                wide
                figures={
                    <Figures
                        items={[
                            {
                                label: i18n("Usually"),
                                value:
                                    medianLatency === null
                                        ? "–"
                                        : minutes(medianLatency),
                            },
                            {
                                label: i18n("Nine out of ten within"),
                                value:
                                    tailLatency === null
                                        ? "–"
                                        : minutes(tailLatency),
                            },
                            {
                                label: i18n("Slowest bucket"),
                                value: measuredLatencies.length
                                    ? minutes(Math.max(...measuredLatencies))
                                    : "–",
                            },
                        ]}
                    />
                }
            >
                <Legend series={latencySeries} />
                <TimeChart
                    label={i18n("Time to summary")}
                    labels={labels}
                    series={latencySeries}
                    format={minutes}
                    band
                    height={170}
                />
            </Panel>
        </>
    );
}
