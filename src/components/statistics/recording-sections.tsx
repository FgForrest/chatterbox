"use client";

import { useExtracted } from "next-intl";
import { type DayRange, previousMinutes } from "@/lib/statistics/data";
import { Figures, INK, Legend, Panel, SERIES, TimeChart } from "./charts";
import { Waveform } from "./interactive-charts";
import styles from "./statistics.module.css";
import type { StatisticsView } from "./use-statistics-view";

export function RecordedTime({
    view,
    onRange,
}: {
    view: StatisticsView;
    onRange: (range: DayRange) => void;
}) {
    const i18n = useExtracted();
    const { data, range, number, count, minutes, percent, date, total } = view;
    const minutesTotal = total("minutes");
    const startedCount = total("startedRecordings");
    const prior = previousMinutes(data, range);
    const change = prior ? minutesTotal / prior - 1 : null;
    let changeLabel: string | undefined;
    if (change !== null) {
        if (change >= 0)
            changeLabel = i18n("{percent} more", { percent: percent(change) });
        else
            changeLabel = i18n("{percent} less", { percent: percent(-change) });
    }

    return (
        <section
            className={`${styles.panel} ${styles.hero}`}
            aria-label={i18n("Recorded time")}
        >
            <div>
                <p className={styles.sub}>{i18n("Recorded time")}</p>
                <p className={styles.big}>
                    {Math.floor(Math.round(minutesTotal) / 60)}
                    <small>h</small>
                    {Math.round(minutesTotal) % 60}
                    <small>min</small>
                </p>
                <p className={styles.meta}>
                    {i18n("{count} recordings, averaging {minutes} min", {
                        count: count(startedCount),
                        minutes: number(
                            startedCount ? minutesTotal / startedCount : 0,
                        ),
                    })}
                </p>
                <p className={styles.delta}>
                    {change !== null ? (
                        <>
                            <b>{changeLabel}</b>{" "}
                            {i18n(
                                "than in the previous period of the same length",
                            )}
                        </>
                    ) : (
                        i18n("No recorded time in the previous period.")
                    )}
                </p>
                <div className={styles.sourceBar} aria-hidden="true">
                    {(["plaud", "meeting", "upload"] as const).map(
                        (metric, i) => (
                            <i
                                key={metric}
                                style={{
                                    flex: Math.max(0.001, total(metric)),
                                    background: `color-mix(in oklab, var(--primary) ${100 - i * 32}%, var(--card))`,
                                }}
                            />
                        ),
                    )}
                </div>
                <ul className={styles.sourceLegend}>
                    {[
                        {
                            metric: "plaud" as const,
                            label: i18n("Plaud"),
                        },
                        {
                            metric: "meeting" as const,
                            label: i18n("Meeting Recorder"),
                        },
                        {
                            metric: "upload" as const,
                            label: i18n("Uploaded files"),
                        },
                    ].map((source, i) => (
                        <li key={source.metric}>
                            <i
                                style={{
                                    background: `color-mix(in oklab, var(--primary) ${100 - i * 32}%, var(--card))`,
                                }}
                            />
                            <span>{source.label}</span>
                            <b>
                                {percent(
                                    minutesTotal
                                        ? total(source.metric) / minutesTotal
                                        : 0,
                                )}
                            </b>
                            <span>{minutes(total(source.metric))}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <div className={styles.wavebox}>
                <div className={styles.waveTop}>
                    <p>
                        {date(range.start)} / {date(range.end)}
                    </p>
                    <p>
                        {i18n(
                            "Drag across the waveform to choose a custom range.",
                        )}
                    </p>
                </div>
                <Waveform
                    data={data}
                    range={range}
                    onRange={onRange}
                    format={minutes}
                />
                <p className={styles.hint}>
                    {i18n(
                        "Arrow keys inspect the waveform. Enter sets a selection start and end; Shift + arrows extends it.",
                    )}
                </p>
            </div>
        </section>
    );
}

export function ActivitySections({ view }: { view: StatisticsView }) {
    const i18n = useExtracted();
    const { count, labels, total, atEnd, series } = view;
    const recordingCount = total("recordings");
    const recordingSeries = [
        series(i18n("Recordings"), "recordings", INK),
        series(i18n("Transcripts"), "transcripts", SERIES[0]),
        series(i18n("Summaries"), "summaries", SERIES[2]),
    ];
    const mailSeries = [
        series(i18n("Mail received"), "mail", INK),
        series(i18n("Mail summarized"), "mailSummaries", SERIES[2]),
    ];
    const taskSeries = [
        series(
            i18n({ id: "statistics_tasksNew", message: "New" }),
            "tasksCreated",
            INK,
        ),
        {
            ...series(
                i18n({ id: "statistics_tasksDone", message: "Done" }),
                "tasksDone",
                SERIES[1],
            ),
            down: true,
        },
        {
            ...series(
                i18n({ id: "statistics_tasksDropped", message: "Dropped" }),
                "tasksDropped",
                "var(--muted-foreground)",
            ),
            down: true,
        },
    ];

    return (
        <>
            <Panel
                title={i18n("Recordings, transcripts and summaries")}
                figures={
                    <Figures
                        items={recordingSeries.map((s, i) => ({
                            label: s.label,
                            value: count(
                                [
                                    recordingCount,
                                    total("transcripts"),
                                    total("summaries"),
                                ][i],
                            ),
                        }))}
                    />
                }
            >
                <Legend series={recordingSeries} />
                <TimeChart
                    label={i18n(
                        "Recordings, transcripts and summaries over time",
                    )}
                    labels={labels}
                    series={recordingSeries}
                    format={count}
                    minimumStep={1}
                />
            </Panel>
            <Panel
                title={i18n("Mail")}
                figures={
                    <Figures
                        items={[
                            {
                                label: i18n("Received"),
                                value: count(total("mail")),
                            },
                            {
                                label: i18n("Summarized"),
                                value: count(total("mailSummaries")),
                            },
                        ]}
                    />
                }
            >
                <Legend series={mailSeries} />
                <TimeChart
                    label={i18n("Mail received and summarized over time")}
                    labels={labels}
                    series={mailSeries}
                    format={count}
                    minimumStep={1}
                />
            </Panel>
            <Panel
                title={i18n("Tasks")}
                subtitle={i18n("New above the axis, resolved below.")}
                figures={
                    <Figures
                        items={[
                            {
                                label: i18n({
                                    id: "statistics_tasksNew",
                                    message: "New",
                                }),
                                value: count(total("tasksCreated")),
                            },
                            {
                                label: i18n({
                                    id: "statistics_tasksDone",
                                    message: "Done",
                                }),
                                value: count(total("tasksDone")),
                            },
                            {
                                label: i18n({
                                    id: "statistics_tasksDropped",
                                    message: "Dropped",
                                }),
                                value: count(total("tasksDropped")),
                            },
                            {
                                label: i18n("Open at range end"),
                                value: count(atEnd("openTasks")),
                            },
                        ]}
                    />
                }
            >
                <Legend
                    series={[
                        ...taskSeries,
                        {
                            label: i18n({
                                id: "statistics_tasksOpen",
                                message: "Open",
                            }),
                            color: SERIES[3],
                        },
                    ]}
                />
                <TimeChart
                    label={i18n("New and resolved tasks over time")}
                    labels={labels}
                    series={taskSeries}
                    format={count}
                    minimumStep={1}
                    columns
                    height={200}
                />
                <TimeChart
                    label={i18n("Open tasks over time")}
                    labels={labels}
                    series={[
                        {
                            ...series(
                                i18n("Open tasks"),
                                "openTasks",
                                SERIES[3],
                                true,
                            ),
                            area: true,
                        },
                    ]}
                    format={count}
                    minimumStep={1}
                    height={100}
                />
                <p className={styles.hint}>
                    {i18n(
                        "Task history records status changes. Older tasks without history use their latest status; dismissed proposals do not count as dropped tasks.",
                    )}
                </p>
            </Panel>
        </>
    );
}
