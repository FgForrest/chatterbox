export type StatisticsScope = "mine" | "organization" | "everyone";

export function isStatisticsScope(value: string): value is StatisticsScope {
    return value === "mine" || value === "organization" || value === "everyone";
}

export const METRICS = [
    "recordings",
    "minutes",
    "plaud",
    "meeting",
    "upload",
    "transcripts",
    "summaries",
    "mail",
    "mailSummaries",
    "tasksCreated",
    "tasksDone",
    "tasksDropped",
    "openTasks",
    "transcriptionCost",
    "learnCost",
    "summaryCost",
    "topicsCost",
    "titleCost",
    "mailCost",
    "audioBytes",
    "mailBytes",
    "people",
    "entities",
    "terms",
    "aliases",
    "corrections",
    "unpriced",
    "otherCost",
    "startedRecordings",
    "audioCost",
] as const;

export type Metric = (typeof METRICS)[number];
export const metricIndex = Object.fromEntries(
    METRICS.map((key, i) => [key, i]),
) as Record<Metric, number>;

export interface StatisticsData {
    scope: StatisticsScope;
    tz: string;
    start: string;
    days: number;
    daily: number[][];
    baseline: number[];
    measuredFrom: string | null;
    comparisonMinutes: number[];
    members: [name: string | null, you: boolean][];
    ranking: string[];
    models: [provider: string, model: string][];
    modelDays: [
        day: number,
        model: number,
        step: number,
        jobs: number,
        cost: number,
        unpriced: number,
        failed?: number,
    ][];
    heat: [day: number, hour: number, count: number][];
    latency: [day: number, seconds: number, count: number][];
}

export interface DayRange {
    start: number;
    end: number;
}

export type RankingRow = [
    day: number,
    member: number,
    minutes: number,
    mail: number,
    resolved: number,
    cost: number,
];

/** Per-member daily aggregates, delta-coded with zero runs and unsigned varints; milliseconds and microdollars preserve the displayed precision. */
export function packRanking(rows: RankingRow[], members: number): string[] {
    const grouped = Array.from({ length: members }, () => [] as RankingRow[]);
    for (const row of rows) grouped[row[1]].push(row);
    return grouped.map((group) => {
        if (!group.length) return "";
        const values: number[] = [];
        const previous = [-1, 0, 0, 0, 0];
        for (const [day, , minutes, mail, resolved, cost] of group.sort(
            (a, b) => a[0] - b[0],
        )) {
            const fields = [
                day,
                Math.round(minutes * 60_000),
                mail,
                resolved,
                Math.round(cost * 1e6),
            ];
            fields.forEach((value, field) => {
                values.push(value - previous[field]);
                previous[field] = value;
            });
        }
        let binary = "";
        function write(value: number) {
            do {
                const low = value % 128;
                value = Math.floor(value / 128);
                binary += String.fromCharCode(low + (value ? 128 : 0));
            } while (value);
        }
        for (let i = 0; i < values.length; i++) {
            if (values[i] === 0) {
                let count = 1;
                while (values[i + count] === 0) count++;
                write(0);
                write(count);
                i += count - 1;
            } else
                write((values[i] < 0 ? -values[i] * 2 - 1 : values[i] * 2) + 1);
        }
        return btoa(binary);
    });
}

/** Expands the aggregate-only ranking once per loaded scope, before local range selection. */
export function unpackRanking(packed: string[]): RankingRow[] {
    const rows: RankingRow[] = [];
    packed.forEach((encoded, member) => {
        const binary = atob(encoded);
        let offset = 0;
        function read(): number {
            let value = 0,
                multiplier = 1,
                byte = 0;
            do {
                byte = binary.charCodeAt(offset++);
                value += (byte % 128) * multiplier;
                multiplier *= 128;
            } while (byte >= 128);
            return value;
        }
        const previous = [-1, 0, 0, 0, 0];
        let field = 0;
        function append(delta: number) {
            previous[field] += delta;
            field++;
            if (field === 5) {
                rows.push([
                    previous[0],
                    member,
                    previous[1] / 60_000,
                    previous[2],
                    previous[3],
                    previous[4] / 1e6,
                ]);
                field = 0;
            }
        }
        while (offset < binary.length) {
            const value = read();
            if (value === 0) {
                const count = read();
                for (let i = 0; i < count; i++) append(0);
            } else {
                const signed = value - 1;
                append(signed % 2 ? -(signed + 1) / 2 : signed / 2);
            }
        }
    });
    return rows;
}

const zones = new Set<string>(Intl.supportedValuesOf("timeZone"));

export function validateTimeZone(value: string | null | undefined): string {
    return value && (value === "UTC" || zones.has(value)) ? value : "UTC";
}

export function calendarDay(date: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: validateTimeZone(tz),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

export function shiftDay(day: string, offset: number): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
}

export function sliceRange(start: number, end: number, days = 365): DayRange {
    const a = Math.max(0, Math.min(days - 1, Math.floor(start)));
    const b = Math.max(0, Math.min(days - 1, Math.floor(end)));
    return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Daily through 62 days; longer ranges use seven-day buckets ending on the range end, with a clipped first bucket. */
export function bucketize(range: DayRange): DayRange[] {
    const size = range.end - range.start + 1 <= 62 ? 1 : 7;
    const result: DayRange[] = [];
    for (let end = range.end; end >= range.start; end -= size) {
        result.unshift({ start: Math.max(range.start, end - size + 1), end });
    }
    return result;
}

export function sum(values: readonly number[], range: DayRange): number {
    let total = 0;
    for (
        let i = Math.max(0, range.start);
        i <= Math.min(values.length - 1, range.end);
        i++
    )
        total += values[i];
    return total;
}

export function previousMinutes(data: StatisticsData, range: DayRange): number {
    const length = range.end - range.start + 1;
    return sum(
        [...data.comparisonMinutes, ...data.daily[metricIndex.minutes]],
        {
            start: data.days + range.start - length,
            end: data.days + range.start - 1,
        },
    );
}

export function niceStep(value: number): number {
    if (value <= 0 || !Number.isFinite(value)) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    const fraction = value / power;
    if (fraction <= 1) return power;
    if (fraction <= 2) return 2 * power;
    if (fraction <= 5) return 5 * power;
    return 10 * power;
}

export function chartScale(value: number, divisions = 4) {
    const step = niceStep(Math.max(value, 1e-9) / divisions);
    const max = Math.max(step, Math.ceil(value / step) * step);
    return {
        step,
        max,
        ticks: Array.from(
            { length: Math.round(max / step) + 1 },
            (_, i) => i * step,
        ),
    };
}

export function tickIndices(length: number, width: number): number[] {
    const step = Math.max(
        1,
        Math.ceil(length / Math.max(1, Math.floor(width / 70))),
    );
    return Array.from({ length: Math.ceil(length / step) }, (_, i) => i * step);
}

/** Meeting Recorder uses the local upload path, so its file prefix takes precedence over deviceSn. */
export function recordingSource(
    deviceSn: string,
    plaudFileId: string,
): "upload" | "meeting" | "plaud" {
    if (plaudFileId.startsWith("meeting-")) return "meeting";
    return deviceSn === "local" || plaudFileId.startsWith("uploaded-")
        ? "upload"
        : "plaud";
}

/** Weighted percentile of second-resolution latency counts, preserving the distribution across daily and weekly buckets. */
export function latencyPercentile(
    rows: StatisticsData["latency"],
    range: DayRange,
    percentile: number,
): number | null {
    const selected = rows
        .filter(([day]) => day >= range.start && day <= range.end)
        .sort((a, b) => a[1] - b[1]);
    const count = selected.reduce((total, row) => total + row[2], 0);
    if (!count) return null;
    const position = (count - 1) * percentile;
    let seen = 0;
    let low = 0;
    for (const [, seconds, n] of selected) {
        if (Math.floor(position) >= seen && Math.floor(position) < seen + n)
            low = seconds;
        if (Math.ceil(position) < seen + n)
            return (low + (seconds - low) * (position % 1)) / 60;
        seen += n;
    }
    return null;
}
