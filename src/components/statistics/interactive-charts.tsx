"use client";

import { useExtracted, useLocale } from "next-intl";
import {
    type KeyboardEvent,
    useCallback,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    type DayRange,
    metricIndex,
    type StatisticsData,
    shiftDay,
    sum,
} from "@/lib/statistics/data";
import {
    ChartTooltip,
    chartFocusIndex,
    DataTable,
    INK,
    useChartWidth,
} from "./charts";
import styles from "./statistics.module.css";

export function Waveform({
    data,
    range,
    onRange,
    format,
}: {
    data: StatisticsData;
    range: DayRange;
    onRange: (range: DayRange) => void;
    format: (value: number) => string;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const { ref, width } = useChartWidth();
    const [active, setActive] = useState<number | null>(null);
    const [draft, setDraft] = useState<DayRange | null>(null);
    const drag = useRef<number | null>(null);
    const keyboardAnchor = useRef<DayRange | null>(null);
    const step = width / data.days < 2.4 ? 7 : 1;
    const groups: DayRange[] = [];
    for (let end = data.days - 1; end >= 0; end -= step)
        groups.unshift({ start: Math.max(0, end - step + 1), end });
    const values = groups.map((group) =>
        sum(data.daily[metricIndex.minutes], group),
    );
    const max = Math.max(1, ...values);
    const selected = draft ?? range;
    const dateFormatter = useMemo(
        () =>
            new Intl.DateTimeFormat(locale, {
                day: "numeric",
                month: "numeric",
                timeZone: "UTC",
            }),
        [locale],
    );
    const date = useCallback(
        (index: number) =>
            dateFormatter.format(
                new Date(`${shiftDay(data.start, index)}T00:00:00Z`),
            ),
        [data.start, dateFormatter],
    );
    const tableRows = useCallback(
        () =>
            data.daily[metricIndex.minutes].map((value, i) => [
                date(i),
                format(value),
            ]),
        [data.daily, date, format],
    );
    const months = useMemo(() => {
        const formatter = new Intl.DateTimeFormat(locale, {
            month: "short",
            timeZone: "UTC",
        });
        return Array.from({ length: data.days }, (_, i) => ({
            index: i,
            day: shiftDay(data.start, i),
        }))
            .filter(({ day }) => day.endsWith("-01"))
            .map(({ index, day }) => ({
                index,
                label: formatter.format(new Date(`${day}T00:00:00Z`)),
            }));
    }, [data.days, data.start, locale]);
    function dayAt(clientX: number, element: SVGSVGElement) {
        const bounds = element.getBoundingClientRect();
        return Math.max(
            0,
            Math.min(
                data.days - 1,
                Math.floor(
                    ((clientX - bounds.left) / bounds.width) * data.days,
                ),
            ),
        );
    }
    function keyboard(event: KeyboardEvent<SVGSVGElement>) {
        if (event.key === "Escape") {
            keyboardAnchor.current = null;
            setActive(null);
            setDraft(null);
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const group = groups[active ?? groups.length - 1];
            if (keyboardAnchor.current === null) keyboardAnchor.current = group;
            else {
                onRange({
                    start: Math.min(keyboardAnchor.current.start, group.start),
                    end: Math.max(keyboardAnchor.current.end, group.end),
                });
                keyboardAnchor.current = null;
            }
            return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
        event.preventDefault();
        const next = chartFocusIndex(event.key, active, groups.length);
        if (event.shiftKey || keyboardAnchor.current !== null) {
            const anchor =
                keyboardAnchor.current ?? groups[active ?? groups.length - 1];
            keyboardAnchor.current = anchor;
            onRange({
                start: Math.min(anchor.start, groups[next].start),
                end: Math.max(anchor.end, groups[next].end),
            });
        }
        setActive(next);
    }
    return (
        <div className={styles.wave} ref={ref}>
            <svg
                role="img"
                aria-label={i18n(
                    "Recorded time by day over the last year; the selected range is highlighted",
                )}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The waveform is a keyboard-operable range brush.
                tabIndex={0}
                width="100%"
                height="132"
                viewBox={`0 0 ${width} 132`}
                onKeyDown={keyboard}
                onFocus={() => setActive(groups.length - 1)}
                onBlur={() => {
                    setActive(null);
                    keyboardAnchor.current = null;
                }}
                onPointerDown={(event) => {
                    drag.current = dayAt(event.clientX, event.currentTarget);
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const day = dayAt(event.clientX, event.currentTarget);
                    setActive(
                        groups.findIndex(
                            (group) => day >= group.start && day <= group.end,
                        ),
                    );
                    if (drag.current !== null)
                        setDraft({
                            start: Math.min(drag.current, day),
                            end: Math.max(drag.current, day),
                        });
                }}
                onPointerUp={(event) => {
                    if (drag.current === null) return;
                    const day = dayAt(event.clientX, event.currentTarget);
                    onRange({
                        start: Math.min(drag.current, day),
                        end: Math.max(drag.current, day),
                    });
                    drag.current = null;
                    setDraft(null);
                    setActive(null);
                }}
                onPointerCancel={() => {
                    drag.current = null;
                    setDraft(null);
                    setActive(null);
                }}
                onPointerLeave={() => {
                    if (drag.current === null) setActive(null);
                }}
            >
                <title>
                    {i18n("Drag across the waveform to choose a custom range.")}
                </title>
                <line
                    x1={0}
                    x2={width}
                    y1={54}
                    y2={54}
                    stroke="var(--border)"
                />
                {groups.map((group, i) => {
                    const height = Math.max(1.5, (values[i] / max) * 102);
                    const slot = width / groups.length;
                    return (
                        <rect
                            key={group.start}
                            x={slot * i + slot * 0.19}
                            y={54 - height / 2}
                            width={Math.max(1, slot * 0.62)}
                            height={height}
                            rx={1.5}
                            fill={
                                group.end >= selected.start &&
                                group.start <= selected.end
                                    ? "var(--primary)"
                                    : "var(--border)"
                            }
                        />
                    );
                })}
                {months.map(({ index, label }) => (
                    <text
                        key={index}
                        x={(index / data.days) * width + 2}
                        y={129}
                    >
                        {label}
                    </text>
                ))}
            </svg>
            {active !== null && active >= 0 && (
                <ChartTooltip
                    title={`${date(groups[active].start)} – ${date(groups[active].end)}`}
                    rows={[
                        {
                            label: i18n("Recorded time"),
                            value: format(values[active]),
                            color: "var(--primary)",
                        },
                        {
                            label: i18n("Recordings"),
                            value: String(
                                sum(
                                    data.daily[metricIndex.startedRecordings],
                                    groups[active],
                                ),
                            ),
                        },
                    ]}
                />
            )}
            <DataTable
                label={i18n("Recorded time")}
                columns={[i18n("Period"), i18n("Recorded time")]}
                rows={tableRows}
            />
        </div>
    );
}

export interface RankedRow {
    key: string;
    name: string;
    subtitle?: string;
    you?: boolean;
    parts: { label: string; color: string; value: number; detail: string }[];
    value: number;
    formatted: string;
}

export function RankedRows({
    label,
    rows,
    numbered = false,
}: {
    label: string;
    rows: RankedRow[];
    numbered?: boolean;
}) {
    const i18n = useExtracted();
    const [active, setActive] = useState<string | null>(null);
    const tableRows = useCallback(
        () =>
            rows.map((row) => [
                row.subtitle ? `${row.subtitle} · ${row.name}` : row.name,
                row.formatted,
                ...row.parts.map((part) => part.detail),
            ]),
        [rows],
    );
    const max = Math.max(1e-9, ...rows.map((row) => row.value));
    const selected = rows.find((row) => row.key === active);
    return (
        <div className={styles.rankHost}>
            {rows.length === 0 ? (
                <p className={styles.empty}>
                    {i18n("No activity in this period.")}
                </p>
            ) : (
                <ol className={styles.ranking}>
                    {rows.map((row, i) => (
                        <li key={row.key}>
                            <button
                                type="button"
                                onPointerEnter={() => setActive(row.key)}
                                onPointerLeave={() => setActive(null)}
                                onFocus={() => setActive(row.key)}
                                onBlur={() => setActive(null)}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") setActive(null);
                                }}
                            >
                                <span className={styles.who}>
                                    {numbered && (
                                        <>
                                            <span className={styles.position}>
                                                {i + 1}
                                            </span>
                                            <span
                                                className={styles.avatar}
                                                aria-hidden="true"
                                            >
                                                {row.name
                                                    .split(/\s+/)
                                                    .map((part) => part[0])
                                                    .join("")
                                                    .slice(0, 2)}
                                            </span>
                                        </>
                                    )}
                                    <span className={styles.name}>
                                        {row.name}
                                        {row.subtitle && (
                                            <small>{row.subtitle}</small>
                                        )}
                                        {row.you && <em>{i18n("you")}</em>}
                                    </span>
                                </span>
                                <span
                                    className={styles.track}
                                    aria-hidden="true"
                                >
                                    {row.parts.map((part) => (
                                        <i
                                            key={part.label}
                                            style={{
                                                width: `${(part.value / max) * 100}%`,
                                                background: part.color,
                                            }}
                                        />
                                    ))}
                                </span>
                                <span className={styles.value}>
                                    {row.formatted}
                                </span>
                            </button>
                        </li>
                    ))}
                </ol>
            )}
            {selected && (
                <ChartTooltip
                    title={selected.name}
                    rows={selected.parts.map((part) => ({
                        label: part.label,
                        value: part.detail,
                        color: part.color,
                    }))}
                />
            )}
            <DataTable
                label={label}
                columns={[
                    i18n("Name"),
                    i18n("Total"),
                    ...(rows[0]?.parts.map((part) => part.label) ?? []),
                ]}
                rows={tableRows}
            />
        </div>
    );
}

export function Heatmap({
    data,
    range,
}: {
    data: StatisticsData;
    range: DayRange;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const [active, setActive] = useState<number | null>(null);
    const cells = useMemo(() => {
        const cells = Array.from({ length: 7 }, () =>
            Array<number>(24).fill(0),
        );
        for (const [day, hour, count] of data.heat) {
            if (day < range.start || day > range.end) continue;
            const weekday =
                (new Date(
                    `${shiftDay(data.start, day)}T00:00:00Z`,
                ).getUTCDay() +
                    6) %
                7;
            cells[weekday][hour] += count;
        }
        return cells;
    }, [data.heat, data.start, range.start, range.end]);
    const max = Math.max(1, ...cells.flat());
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const weekdays = useMemo(() => {
        const formatter = new Intl.DateTimeFormat(locale, {
            weekday: "short",
            timeZone: "UTC",
        });
        return Array.from({ length: 7 }, (_, day) =>
            formatter.format(new Date(Date.UTC(2026, 0, 5 + day))),
        );
    }, [locale]);
    const rows = useMemo(
        () =>
            cells.flatMap((row, day) =>
                row.map((count, hour) => ({ day, hour, count })),
            ),
        [cells],
    );
    const tableRows = useCallback(
        () =>
            rows.map(({ day, hour, count }) => [
                weekdays[day],
                `${hour}:00–${hour + 1}:00`,
                count,
            ]),
        [rows, weekdays],
    );
    const chosen = active === null ? null : rows[active];
    const busiest = rows.reduce(
        (best, row) => (row.count > best.count ? row : best),
        rows[0],
    );
    return (
        <div className={styles.heatHost}>
            <p className={styles.sub}>
                {busiest.count
                    ? i18n(
                          "Most recordings start {day, select, 1 {on Monday} 2 {on Tuesday} 3 {on Wednesday} 4 {on Thursday} 5 {on Friday} 6 {on Saturday} 7 {on Sunday} other {on this day}} between {from}:00 and {to}:00.",
                          {
                              day: String(busiest.day + 1),
                              from: String(busiest.hour),
                              to: String(busiest.hour + 1),
                          },
                      )
                    : i18n("No activity in this period.")}{" "}
                <span>{data.tz}</span>
            </p>
            <div className={styles.heatScroll}>
                <div className={styles.heat}>
                    <span />
                    {hours.map((hour) => (
                        <span key={`hour-${hour}`}>
                            {hour % 3 === 0 ? hour : ""}
                        </span>
                    ))}
                    {cells.map((row, day) => (
                        <div className={styles.heatRow} key={weekdays[day]}>
                            <span>{weekdays[day]}</span>
                            {row.map((count, hour) => (
                                <button
                                    key={`${weekdays[day]}:${hour}:00`}
                                    type="button"
                                    aria-label={`${weekdays[day]} ${hour}:00–${hour + 1}:00: ${count}`}
                                    style={{
                                        background: count
                                            ? `color-mix(in oklab, var(--primary) ${16 + Math.ceil((count / max) * 4) * 19}%, var(--card))`
                                            : "var(--muted)",
                                    }}
                                    onPointerEnter={() =>
                                        setActive(day * 24 + hour)
                                    }
                                    onPointerLeave={() => setActive(null)}
                                    onFocus={() => setActive(day * 24 + hour)}
                                    onBlur={() => setActive(null)}
                                    onKeyDown={(event) => {
                                        if (
                                            ![
                                                "ArrowLeft",
                                                "ArrowRight",
                                                "ArrowUp",
                                                "ArrowDown",
                                            ].includes(event.key)
                                        )
                                            return;
                                        event.preventDefault();
                                        const next = Math.max(
                                            0,
                                            Math.min(
                                                167,
                                                day * 24 +
                                                    hour +
                                                    ({
                                                        ArrowLeft: -1,
                                                        ArrowRight: 1,
                                                        ArrowUp: -24,
                                                        ArrowDown: 24,
                                                    }[event.key] ?? 0),
                                            ),
                                        );
                                        event.currentTarget
                                            .closest(`.${styles.heat}`)
                                            ?.querySelectorAll("button")
                                            [next]?.focus();
                                    }}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
            <div className={styles.legend}>
                <span>{i18n("less")}</span>
                {[16, 35, 54, 73, 92].map((amount) => (
                    <i
                        key={amount}
                        style={{
                            background: `color-mix(in oklab, var(--primary) ${amount}%, var(--card))`,
                            width: 14,
                            height: 10,
                            borderRadius: 2,
                        }}
                    />
                ))}
                <span>{i18n("more")}</span>
            </div>
            {chosen && (
                <ChartTooltip
                    title={`${weekdays[chosen.day]} ${chosen.hour}:00–${chosen.hour + 1}:00`}
                    rows={[
                        {
                            label: i18n("Recordings"),
                            value: new Intl.NumberFormat(locale).format(
                                chosen.count,
                            ),
                            color: INK,
                        },
                    ]}
                />
            )}
            <DataTable
                label={i18n("When people talk")}
                columns={[i18n("Day"), i18n("Hour"), i18n("Recordings")]}
                rows={tableRows}
            />
        </div>
    );
}
