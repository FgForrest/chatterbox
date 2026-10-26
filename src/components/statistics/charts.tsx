"use client";

import { useExtracted } from "next-intl";
import {
    type KeyboardEvent,
    type ReactNode,
    useCallback,
    useId,
    useState,
} from "react";
import { chartScale, niceStep, tickIndices } from "@/lib/statistics/data";
import styles from "./statistics.module.css";

export const SERIES = [
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-3)",
    "var(--series-4)",
    "var(--series-5)",
];
export const INK = "var(--foreground)";

export function chartFocusIndex(
    key: string,
    active: number | null,
    count: number,
): number {
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    const direction = key === "ArrowRight" ? 1 : -1;
    return Math.max(0, Math.min(count - 1, (active ?? count - 1) + direction));
}

export interface ChartSeries {
    label: string;
    color: string;
    values: (number | null)[];
    raw?: (number | null)[];
    down?: boolean;
    area?: boolean;
    base?: number[];
    dashed?: boolean;
    estimatedUntil?: number;
}

export function useChartWidth() {
    const [width, setWidth] = useState(540);
    const ref = useCallback((element: HTMLDivElement | null) => {
        if (!element) return;
        function measure(nextWidth: number) {
            // Hidden or transient zero-size layouts must retain the last usable width.
            if (nextWidth > 0) setWidth(nextWidth);
        }
        measure(element.getBoundingClientRect().width);
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            measure(entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { ref, width };
}

export function ChartTooltip({
    title,
    rows,
}: {
    title: string;
    rows: { label: string; value: string; color?: string }[];
}) {
    return (
        <div role="tooltip" className={styles.tooltip}>
            <p>{title}</p>
            {rows.map((row) => (
                <div key={row.label}>
                    <i style={{ background: row.color }} />
                    <b>{row.value}</b>
                    <span>{row.label}</span>
                </div>
            ))}
        </div>
    );
}

export function DataTable({
    label,
    columns,
    rows,
}: {
    label: string;
    columns: string[];
    rows: (string | number)[][];
}) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    return (
        <details
            className={styles.table}
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary>{i18n("Show as a table")}</summary>
            {open && (
                <div>
                    <table aria-label={label}>
                        <thead>
                            <tr>
                                {columns.map((column) => (
                                    <th key={column} scope="col">
                                        {column}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, i) => (
                                <tr key={`${i}:${row[0]}`}>
                                    {row.map((cell, j) =>
                                        j === 0 ? (
                                            <th key={columns[j]} scope="row">
                                                {cell}
                                            </th>
                                        ) : (
                                            <td key={columns[j]}>{cell}</td>
                                        ),
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </details>
    );
}

export function Legend({
    series,
}: {
    series: Pick<ChartSeries, "label" | "color" | "dashed">[];
}) {
    return (
        <ul className={styles.legend}>
            {series.map((s) => (
                <li key={s.label}>
                    <i
                        style={{
                            background: s.dashed ? undefined : s.color,
                            borderTop: s.dashed
                                ? `2px dashed ${s.color}`
                                : undefined,
                        }}
                    />
                    {s.label}
                </li>
            ))}
        </ul>
    );
}

export function Panel({
    title,
    subtitle,
    wide,
    children,
    controls,
    figures,
}: {
    title: string;
    subtitle?: string;
    wide?: boolean;
    children: ReactNode;
    controls?: ReactNode;
    figures?: ReactNode;
}) {
    return (
        <section
            className={`${styles.panel} ${styles.viz} ${wide ? styles.wide : ""}`}
            aria-label={title}
        >
            <header>
                <div>
                    <h2>{title}</h2>
                    {subtitle && <p className={styles.sub}>{subtitle}</p>}
                </div>
                {controls}
                {figures}
            </header>
            {children}
        </section>
    );
}

export function Figures({
    items,
}: {
    items: { label: string; value: ReactNode }[];
}) {
    return (
        <dl className={styles.figures}>
            {items.map(({ label, value }) => (
                <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function Segmented<T extends string>({
    label,
    options,
    value,
    onChange,
    onWarm,
}: {
    label: string;
    options: { value: T; label: string; icon?: ReactNode }[];
    value: T;
    onChange: (value: T) => void;
    onWarm?: (value: T) => void;
}) {
    const groupId = useId();
    return (
        <fieldset className={styles.segmented}>
            <legend className="sr-only">{label}</legend>
            {options.map((option) => (
                <label
                    key={option.value}
                    onPointerEnter={() => onWarm?.(option.value)}
                >
                    <input
                        type="radio"
                        className="sr-only"
                        name={groupId}
                        value={option.value}
                        checked={value === option.value}
                        onChange={() => onChange(option.value)}
                        onFocus={() => onWarm?.(option.value)}
                    />
                    {option.icon}
                    {option.label}
                </label>
            ))}
        </fieldset>
    );
}

export function TimeChart({
    label,
    labels,
    series,
    format,
    columns = false,
    height = 190,
    band = false,
    minimumStep = 0,
}: {
    label: string;
    labels: string[];
    series: ChartSeries[];
    format: (value: number) => string;
    columns?: boolean;
    height?: number;
    band?: boolean;
    minimumStep?: number;
}) {
    const i18n = useExtracted();
    const { ref, width } = useChartWidth();
    const [focused, setFocused] = useState<number | null>(null);
    const id = useId();
    const right = width - 12,
        top = 12,
        bottom = height - 26;
    const count = labels.length;
    const active = focused === null ? null : Math.min(focused, count - 1);
    const upTotals = labels.map((_, i) =>
        series
            .filter((s) => !s.down)
            .reduce((total, s) => total + (s.values[i] ?? 0), 0),
    );
    const downTotals = labels.map((_, i) =>
        series
            .filter((s) => s.down)
            .reduce((total, s) => total + (s.values[i] ?? 0), 0),
    );
    const maxValue = columns
        ? Math.max(0, ...upTotals)
        : Math.max(
              0,
              ...series.flatMap((s) =>
                  s.values.filter((v): v is number => v !== null),
              ),
          );
    const downMax = columns ? Math.max(0, ...downTotals) : 0;
    const scaled = chartScale(maxValue, height < 120 ? 2 : 4);
    const step = Math.max(
        minimumStep,
        downMax > 0 ? niceStep((maxValue + downMax) / 5) : scaled.step,
    );
    const max = Math.max(step, Math.ceil(maxValue / step) * step);
    const min = downMax > 0 ? -Math.ceil(downMax / step) * step : 0;
    const ticks = Array.from(
        { length: Math.round((max - min) / step) + 1 },
        (_, i) => min + i * step,
    );
    const left = Math.max(
        54,
        ...ticks.map((tick) => format(Math.abs(tick)).length * 7 + 8),
    );
    function x(i: number) {
        let position = 0.5;
        if (columns) position = (i + 0.5) / count;
        else if (count >= 2) position = i / (count - 1);
        return left + position * (right - left);
    }
    const y = (v: number) => top + ((max - v) / (max - min)) * (bottom - top);
    function path(values: (number | null)[]) {
        let pen = false;
        return values
            .map((value, i) => {
                if (value === null) {
                    pen = false;
                    return "";
                }
                const command = `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
                pen = true;
                return command;
            })
            .join("");
    }
    const bandSegments: number[][] = [];
    if (band && series.length === 2) {
        let segment: number[] = [];
        for (let i = 0; i < count; i++) {
            if (series[0].values[i] === null || series[1].values[i] === null) {
                segment = [];
            } else {
                if (segment.length === 0) bandSegments.push(segment);
                segment.push(i);
            }
        }
    }
    const bandPath = bandSegments
        .filter((segment) => segment.length > 1)
        .map(
            (segment) =>
                `${segment.map((i, j) => `${j === 0 ? "M" : "L"}${x(i)},${y(series[1].values[i] ?? 0)}`).join("")}${[
                    ...segment,
                ]
                    .reverse()
                    .map((i) => `L${x(i)},${y(series[0].values[i] ?? 0)}`)
                    .join("")}Z`,
        )
        .join("");
    function keyboard(event: KeyboardEvent<SVGSVGElement>) {
        if (event.key === "Escape") {
            setFocused(null);
            return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
        event.preventDefault();
        setFocused(chartFocusIndex(event.key, active, count));
    }
    return (
        <div className={styles.chart} ref={ref}>
            <svg
                width="100%"
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                role="img"
                aria-label={label}
                aria-describedby={active === null ? undefined : id}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Chart focus enables keyboard exploration of data points.
                tabIndex={0}
                onFocus={() => setFocused(count - 1)}
                onBlur={() => setFocused(null)}
                onKeyDown={keyboard}
                onPointerLeave={() => setFocused(null)}
                onPointerMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const position =
                        (((event.clientX - rect.left) * width) / rect.width -
                            left) /
                        (right - left);
                    setFocused(
                        Math.max(
                            0,
                            Math.min(
                                count - 1,
                                Math.round(
                                    position * (columns ? count : count - 1) -
                                        (columns ? 0.5 : 0),
                                ),
                            ),
                        ),
                    );
                }}
            >
                <title>{label}</title>
                {ticks.map((tick) => (
                    <g key={tick}>
                        <line
                            x1={left}
                            x2={right}
                            y1={y(tick)}
                            y2={y(tick)}
                            stroke="var(--border)"
                            opacity={tick === 0 ? 1 : 0.5}
                        />
                        <text x={left - 8} y={y(tick) + 4} textAnchor="end">
                            {format(Math.abs(tick))}
                        </text>
                    </g>
                ))}
                {tickIndices(count, right - left).map((i) => (
                    <text
                        key={labels[i]}
                        x={x(i)}
                        y={height - 5}
                        textAnchor={i === count - 1 ? "end" : "middle"}
                    >
                        {labels[i].split(" – ")[0]}
                    </text>
                ))}
                {bandPath && (
                    <path d={bandPath} fill={series[0].color} opacity={0.12} />
                )}
                {columns
                    ? labels.map((date, i) => {
                          let up = 0,
                              down = 0;
                          const barWidth = Math.min(
                              24,
                              ((right - left) / count) * 0.66,
                          );
                          return (
                              <g
                                  key={date}
                                  opacity={
                                      active === null || active === i ? 1 : 0.4
                                  }
                              >
                                  {series.map((s) => {
                                      const v = s.values[i] ?? 0;
                                      const from = s.down ? -down : up;
                                      if (s.down) down += v;
                                      else up += v;
                                      const to = s.down ? -down : up;
                                      return (
                                          <rect
                                              key={s.label}
                                              x={x(i) - barWidth / 2}
                                              y={Math.min(y(from), y(to))}
                                              width={barWidth}
                                              height={Math.max(
                                                  0,
                                                  Math.abs(y(to) - y(from)) -
                                                      (from ? 2 : 0),
                                              )}
                                              rx={Math.min(3, barWidth / 2)}
                                              fill={s.color}
                                          />
                                      );
                                  })}
                              </g>
                          );
                      })
                    : series.map((s) => (
                          <g key={s.label}>
                              {(s.area || s.base) && (
                                  <path
                                      d={`${path(s.values)}${s.values
                                          .map((_, j) => {
                                              const i = count - 1 - j;
                                              return `L${x(i)},${y(s.base?.[i] ?? 0)}`;
                                          })
                                          .join("")}Z`}
                                      fill={s.color}
                                      opacity={0.12}
                                  />
                              )}
                              {s.estimatedUntil !== undefined &&
                                  s.estimatedUntil > 0 && (
                                      <path
                                          d={path(
                                              s.values.map((v, i) =>
                                                  i <= (s.estimatedUntil ?? 0)
                                                      ? v
                                                      : null,
                                              ),
                                          )}
                                          fill="none"
                                          stroke={s.color}
                                          strokeWidth={2}
                                          strokeDasharray="3 4"
                                          strokeLinejoin="round"
                                          strokeLinecap="round"
                                      />
                                  )}
                              <path
                                  d={path(
                                      s.values.map((v, i) =>
                                          i >= (s.estimatedUntil ?? 0)
                                              ? v
                                              : null,
                                      ),
                                  )}
                                  fill="none"
                                  stroke={s.color}
                                  strokeWidth={2}
                                  strokeDasharray={s.dashed ? "3 4" : undefined}
                                  strokeLinejoin="round"
                                  strokeLinecap="round"
                              />
                              {s.values[count - 1] !== null && (
                                  <circle
                                      cx={x(count - 1)}
                                      cy={y(s.values[count - 1] ?? 0)}
                                      r={3}
                                      fill={s.color}
                                  />
                              )}
                          </g>
                      ))}
                {active !== null && (
                    <g pointerEvents="none">
                        <line
                            x1={x(active)}
                            x2={x(active)}
                            y1={top}
                            y2={bottom}
                            stroke="var(--muted-foreground)"
                            strokeDasharray="2 3"
                        />
                        {!columns &&
                            series.map(
                                (s) =>
                                    s.values[active] !== null && (
                                        <circle
                                            key={s.label}
                                            cx={x(active)}
                                            cy={y(s.values[active] ?? 0)}
                                            r={4}
                                            fill={s.color}
                                            stroke="var(--card)"
                                            strokeWidth={2}
                                        />
                                    ),
                            )}
                    </g>
                )}
            </svg>
            {active !== null && (
                <div id={id}>
                    <ChartTooltip
                        title={labels[active]}
                        rows={series.map((s) => ({
                            label: s.label,
                            value:
                                (s.raw ?? s.values)[active] === null
                                    ? "–"
                                    : format((s.raw ?? s.values)[active] ?? 0),
                            color: s.color,
                        }))}
                    />
                </div>
            )}
            <DataTable
                label={label}
                columns={[i18n("Period"), ...series.map((s) => s.label)]}
                rows={labels.map((date, i) => [
                    date,
                    ...series.map((s) =>
                        (s.raw ?? s.values)[i] === null
                            ? "–"
                            : format((s.raw ?? s.values)[i] ?? 0),
                    ),
                ])}
            />
        </div>
    );
}
