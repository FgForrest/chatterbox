import {
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Front-matter keys every record must carry, in template order. */
export const REQUIRED_KEYS = [
    "title",
    "date",
    "updated",
    "status",
    "kind",
    "issues",
    "prs",
    "areas",
    "supersedes",
    "superseded-by",
    "relates",
] as const;

/** Allowed `status:` values. */
export const STATUSES = [
    "accepted",
    "partially-implemented",
    "proposed",
    "superseded",
    "rejected",
    "reverted",
] as const;

/** Allowed `kind:` values. */
export const KINDS = [
    "feature",
    "optimization",
    "fix",
    "refactor",
    "infrastructure",
    "process",
] as const;

type Key = (typeof REQUIRED_KEYS)[number];
type RawValue = string | string[];

const ID_PATTERN = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const START_MARKER = "<!-- ADR-INDEX:START -->";
const END_MARKER = "<!-- ADR-INDEX:END -->";
const HEADER = "| Date | Record | Kind | Status | Refs |";
const SEPARATOR = "|------|--------|------|--------|------|";

/** One record, parsed and validated. */
export interface AdrRecord {
    id: string;
    path: string;
    title: string;
    date: string;
    updated: string;
    status: string;
    kind: string;
    issues: number[];
    prs: number[];
    areas: string[];
    supersedes: string[];
    supersededBy: string[];
    relates: string[];
}

/** A validation failure, reported against a path relative to the ADR folder. */
export interface Problem {
    path: string;
    message: string;
}

/** Outcome of one generator run. */
export interface RunResult {
    records: AdrRecord[];
    problems: Problem[];
    stale: boolean;
    written: boolean;
}

function stripComment(value: string): string {
    let quote: string | null = null;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
            return value.slice(0, i);
        }
    }
    return value;
}

function unquote(value: string): string {
    const first = value[0];
    if (
        value.length >= 2 &&
        (first === '"' || first === "'") &&
        value[value.length - 1] === first
    ) {
        return value.slice(1, -1);
    }
    return value;
}

/** Parses the flat YAML front matter the template uses: scalars and `[a, b]` lists. */
export function parseFrontMatter(text: string): {
    fields: Map<string, RawValue>;
    errors: string[];
} {
    const fields = new Map<string, RawValue>();
    const errors: string[] = [];
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
        errors.push("missing front matter: the file must start with `---`");
        return { fields, errors };
    }
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end === -1) {
        errors.push("front matter is not closed with `---`");
        return { fields, errors };
    }
    for (const line of lines.slice(1, end)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
        if (!match) {
            errors.push(
                `cannot read front-matter line \`${line.trim()}\`: use \`key: value\` and flow lists like \`[a, b]\``,
            );
            continue;
        }
        const [, key, rest] = match;
        if (fields.has(key)) {
            errors.push(`front-matter field \`${key}\` appears twice`);
            continue;
        }
        const value = stripComment(rest).trim();
        if (value.startsWith("[")) {
            if (!value.endsWith("]")) {
                errors.push(`\`${key}\` list is not closed with \`]\``);
                continue;
            }
            const inner = value.slice(1, -1).trim();
            fields.set(
                key,
                inner
                    ? inner.split(",").map((item) => unquote(item.trim()))
                    : [],
            );
        } else {
            fields.set(key, unquote(value));
        }
    }
    return { fields, errors };
}

function isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
    );
}

function isTimestamp(value: string): boolean {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(value);
    return (
        match !== null &&
        isCalendarDate(match[1]) &&
        Number(match[2]) < 24 &&
        Number(match[3]) < 60
    );
}

function readRecord(
    id: string,
    path: string,
    text: string,
): { record: AdrRecord | null; problems: Problem[] } {
    const problems: Problem[] = [];
    const report = (message: string) => problems.push({ path, message });
    const { fields, errors } = parseFrontMatter(text);
    for (const error of errors) report(error);
    if (errors.length && fields.size === 0) return { record: null, problems };

    for (const key of REQUIRED_KEYS) {
        if (!fields.has(key)) report(`missing front-matter field \`${key}\``);
    }
    for (const key of fields.keys()) {
        if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
            report(`unknown front-matter field \`${key}\``);
        }
    }

    const scalar = (key: Key): string => {
        const value = fields.get(key);
        if (Array.isArray(value)) {
            report(`\`${key}\` must be a single value, not a list`);
            return "";
        }
        return value ?? "";
    };
    const list = (key: Key): string[] => {
        const value = fields.get(key);
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
            report(`\`${key}\` must be a list such as \`[a, b]\` or \`[]\``);
            return [];
        }
        return value;
    };
    const numbers = (key: Key): number[] =>
        list(key).flatMap((item) => {
            if (!/^[1-9]\d*$/.test(item)) {
                report(
                    `\`${key}\` entry \`${item}\` must be a plain number such as \`123\``,
                );
                return [];
            }
            return [Number(item)];
        });
    const ids = (key: Key): string[] =>
        list(key).filter((item) => {
            if (ID_PATTERN.test(item)) return true;
            report(
                `\`${key}\` entry \`${item}\` is not an ADR id (\`YYYY-MM-DD-<slug>\`)`,
            );
            return false;
        });

    const title = scalar("title");
    if (fields.has("title") && !title) report("`title` is empty");

    const date = scalar("date");
    const filenameDate = ID_PATTERN.exec(id)?.[1] ?? "";
    if (fields.has("date")) {
        if (!isCalendarDate(date)) {
            report(`\`date\` \`${date}\` is not a date in \`YYYY-MM-DD\` form`);
        } else if (date !== filenameDate) {
            report(
                `filename date ${filenameDate} disagrees with \`date: ${date}\``,
            );
        }
    }
    if (!isCalendarDate(filenameDate)) {
        report(`filename date ${filenameDate} is not a calendar date`);
    }

    const updated = scalar("updated");
    if (fields.has("updated")) {
        if (!isTimestamp(updated)) {
            report(
                `\`updated\` \`${updated}\` is not a timestamp in \`YYYY-MM-DD HH:MM\` form`,
            );
        } else if (isCalendarDate(date) && updated.slice(0, 10) < date) {
            report(`\`updated\` ${updated} is earlier than \`date\` ${date}`);
        }
    }

    const status = scalar("status");
    if (
        fields.has("status") &&
        !(STATUSES as readonly string[]).includes(status)
    ) {
        report(
            `\`status\` \`${status}\` is not one of: ${STATUSES.join(", ")}`,
        );
    }
    const kind = scalar("kind");
    if (fields.has("kind") && !(KINDS as readonly string[]).includes(kind)) {
        report(`\`kind\` \`${kind}\` is not one of: ${KINDS.join(", ")}`);
    }

    const areas = list("areas").filter((area) => area.length > 0);
    if (fields.has("areas") && areas.length === 0) {
        report("`areas` must name at least one path the decision lives in");
    }

    return {
        record: {
            id,
            path,
            title,
            date,
            updated,
            status,
            kind,
            issues: numbers("issues"),
            prs: numbers("prs"),
            areas,
            supersedes: ids("supersedes"),
            supersededBy: ids("superseded-by"),
            relates: ids("relates"),
        },
        problems,
    };
}

function checkLinks(records: AdrRecord[]): Problem[] {
    const problems: Problem[] = [];
    const byId = new Map(records.map((record) => [record.id, record]));
    const mirrors: Array<{
        field: "supersedes" | "supersededBy" | "relates";
        key: string;
        mirror: "supersedes" | "supersededBy" | "relates";
        mirrorKey: string;
    }> = [
        {
            field: "supersedes",
            key: "supersedes",
            mirror: "supersededBy",
            mirrorKey: "superseded-by",
        },
        {
            field: "supersededBy",
            key: "superseded-by",
            mirror: "supersedes",
            mirrorKey: "supersedes",
        },
        {
            field: "relates",
            key: "relates",
            mirror: "relates",
            mirrorKey: "relates",
        },
    ];
    for (const record of records) {
        const report = (message: string) =>
            problems.push({ path: record.path, message });
        for (const { field, key, mirror, mirrorKey } of mirrors) {
            for (const target of record[field]) {
                if (target === record.id) {
                    report(`\`${key}\` lists the record itself`);
                    continue;
                }
                const other = byId.get(target);
                if (!other) {
                    report(
                        `\`${key}\` names \`${target}\`, which is not a record`,
                    );
                } else if (!other[mirror].includes(record.id)) {
                    report(
                        `\`${key}\` names \`${target}\`, but its \`${mirrorKey}\` does not list \`${record.id}\``,
                    );
                }
            }
        }
        if (record.supersededBy.length > 0 && record.status !== "superseded") {
            report(
                "has `superseded-by` entries, so `status` must be `superseded`",
            );
        }
        if (
            record.status === "superseded" &&
            record.supersededBy.length === 0
        ) {
            report(
                "`status: superseded` needs the superseding record in `superseded-by`",
            );
        }
    }
    return problems;
}

/** Reads and validates every record in an ADR folder. */
export function collectRecords(adrDir: string): {
    records: AdrRecord[];
    problems: Problem[];
} {
    const records: AdrRecord[] = [];
    const problems: Problem[] = [];
    const seen = new Set<string>();
    for (const name of readdirSync(adrDir).sort()) {
        if (
            name.startsWith(".") ||
            name === "README.md" ||
            name === "TEMPLATE.md"
        )
            continue;
        const full = join(adrDir, name);
        const isDirectory = statSync(full).isDirectory();
        const id = isDirectory ? name : name.replace(/\.md$/, "");
        if (!ID_PATTERN.test(id) || (!isDirectory && !name.endsWith(".md"))) {
            problems.push({
                path: name,
                message:
                    "not a record: name it `YYYY-MM-DD-<slug>.md`, or `YYYY-MM-DD-<slug>/README.md` for a campaign",
            });
            continue;
        }
        if (seen.has(id)) {
            problems.push({
                path: name,
                message: `\`${id}\` exists both as a file and as a directory`,
            });
            continue;
        }
        seen.add(id);
        const path = isDirectory ? `${name}/README.md` : name;
        const text = readIfExists(join(adrDir, path));
        if (text === null) {
            problems.push({
                path: name,
                message: "record directory has no README.md",
            });
            continue;
        }
        const result = readRecord(id, path, text);
        problems.push(...result.problems);
        if (result.record) records.push(result.record);
    }
    problems.push(...checkLinks(records));
    return { records, problems };
}

function escapeCell(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function readIfExists(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

/** Renders the index table, newest record first. */
export function renderIndex(
    records: AdrRecord[],
    repoUrl: string | null,
): string {
    const byId = new Map(records.map((record) => [record.id, record]));
    const sorted = [...records].sort((a, b) =>
        a.date === b.date
            ? a.id.localeCompare(b.id)
            : b.date.localeCompare(a.date),
    );
    const rows = sorted.map((record) => {
        const status =
            record.supersededBy.length > 0
                ? `superseded by ${record.supersededBy
                      .map(
                          (id) =>
                              `[${id}](${byId.get(id)?.path ?? `${id}.md`})`,
                      )
                      .join(", ")}`
                : record.status;
        const refs = [
            ...record.issues.map((n) =>
                repoUrl ? `[#${n}](${repoUrl}/issues/${n})` : `#${n}`,
            ),
            ...record.prs.map((n) =>
                repoUrl ? `[PR #${n}](${repoUrl}/pull/${n})` : `PR #${n}`,
            ),
        ].join(", ");
        return `| ${record.date} | [${escapeCell(record.title)}](${record.path}) | ${record.kind} | ${status} | ${refs} |`;
    });
    return [HEADER, SEPARATOR, ...rows].join("\n");
}

/** Replaces the table between the ADR-INDEX markers; null when the markers are missing. */
export function replaceIndex(readme: string, table: string): string | null {
    const start = readme.indexOf(START_MARKER);
    const end = readme.indexOf(END_MARKER);
    if (start === -1 || end === -1 || end < start) return null;
    return `${readme.slice(0, start + START_MARKER.length)}\n\n${table}\n\n${readme.slice(end)}`;
}

/** The GitHub base URL from package.json's `repository`, or null. */
export function repositoryUrl(packageJsonPath: string): string | null {
    const text = readIfExists(packageJsonPath);
    if (text === null) return null;
    const pkg = JSON.parse(text) as {
        repository?: string | { url?: string };
    };
    const raw =
        typeof pkg.repository === "string"
            ? pkg.repository
            : pkg.repository?.url;
    if (!raw) return null;
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(raw);
    return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** Validates the records and rewrites the index, or with `check` only compares it. */
export function run(options: {
    adrDir: string;
    repoUrl: string | null;
    check: boolean;
}): RunResult {
    const { records, problems } = collectRecords(options.adrDir);
    const readmePath = join(options.adrDir, "README.md");
    const readme = readIfExists(readmePath) ?? "";
    const next = replaceIndex(readme, renderIndex(records, options.repoUrl));
    if (next === null) {
        problems.push({
            path: "README.md",
            message: `missing the ${START_MARKER} / ${END_MARKER} markers`,
        });
        return { records, problems, stale: false, written: false };
    }
    const stale = next !== readme;
    if (stale && !options.check && problems.length === 0) {
        writeFileSync(readmePath, next);
        return { records, problems, stale, written: true };
    }
    return { records, problems, stale, written: false };
}

/**
 * CLI: `node scripts/generate-adr-index.mts [--check] [--plain] [--dir <adr folder>]`.
 * Refs link to the GitHub repository named in package.json's `repository`; `--plain` renders them as
 * plain `#n` / `PR #n`.
 */
export function main(args: string[]): number {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { values } = parseArgs({
        args,
        options: {
            check: { type: "boolean", default: false },
            plain: { type: "boolean", default: false },
            dir: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    const adrDir = resolve(values.dir ?? join(root, "documentation", "adr"));
    const result = run({
        adrDir,
        repoUrl: values.plain
            ? null
            : repositoryUrl(join(root, "package.json")),
        check: values.check,
    });
    const shown = relative(process.cwd(), adrDir) || ".";
    for (const problem of result.problems) {
        console.error(`${join(shown, problem.path)}: ${problem.message}`);
    }
    if (result.problems.length > 0) {
        console.error(
            `${result.problems.length} problem(s) in ${shown}; the index was not updated.`,
        );
        return 1;
    }
    const count = `${result.records.length} record(s)`;
    if (values.check) {
        if (result.stale) {
            console.error(
                `The index in ${join(shown, "README.md")} is stale (${count}). Run: node scripts/generate-adr-index.mts`,
            );
            return 1;
        }
        console.log(`The index is current (${count}).`);
        return 0;
    }
    console.log(
        result.written
            ? `Index updated (${count}).`
            : `Index already current (${count}).`,
    );
    return 0;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    process.exitCode = main(process.argv.slice(2));
}
