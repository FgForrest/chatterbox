import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    parseFrontMatter,
    repositoryUrl,
    run,
} from "../../scripts/generate-adr-index.mjs";

const README = [
    "# Decision records",
    "",
    "<!-- ADR-INDEX:START -->",
    "<!-- ADR-INDEX:END -->",
    "",
].join("\n");

const REPO = "https://github.com/example/chatterbox";

let dir: string;

function frontMatter(overrides: Record<string, string> = {}): string {
    const fields: Record<string, string> = {
        title: "Claim jobs in Postgres",
        date: "2026-07-24",
        updated: "2026-07-24 16:20",
        status: "accepted",
        kind: "infrastructure",
        issues: "[12]",
        prs: "[13]",
        areas: "[src/lib/jobs, src/db/queries/async-jobs.ts]",
        supersedes: "[]",
        "superseded-by": "[]",
        relates: "[]",
        ...overrides,
    };
    const lines = Object.entries(fields)
        .filter(([, value]) => value !== "<omit>")
        .map(([key, value]) => `${key}: ${value}`);
    return ["---", ...lines, "---", "", "# Body", ""].join("\n");
}

function writeRecord(name: string, overrides: Record<string, string> = {}) {
    writeFileSync(join(dir, name), frontMatter(overrides));
}

function messages(check = true) {
    return run({ adrDir: dir, repoUrl: REPO, check }).problems.map(
        (problem) => `${problem.path}: ${problem.message}`,
    );
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adr-index-"));
    writeFileSync(join(dir, "README.md"), README);
    writeFileSync(join(dir, "TEMPLATE.md"), "# Template\n");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("generate-adr-index", () => {
    it("writes a header-only table for an empty folder, then reports it current", () => {
        const first = run({ adrDir: dir, repoUrl: REPO, check: false });
        expect(first.problems).toEqual([]);
        expect(first.written).toBe(true);
        expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(
            "| Date | Record | Kind | Status | Refs |\n|------|--------|------|--------|------|\n\n<!-- ADR-INDEX:END -->",
        );
        const second = run({ adrDir: dir, repoUrl: REPO, check: true });
        expect(second.stale).toBe(false);
    });

    it("renders records newest first with issue and PR links", () => {
        writeRecord("2026-07-24-claim-jobs.md");
        writeRecord("2026-08-01-fair-share.md", {
            title: "Cap jobs per user | not globally",
            date: "2026-08-01",
            updated: "2026-08-02 09:00",
            issues: "[]",
            prs: "[20, 21]",
        });
        const check = run({ adrDir: dir, repoUrl: REPO, check: true });
        expect(check.problems).toEqual([]);
        expect(check.stale).toBe(true);
        expect(check.written).toBe(false);

        run({ adrDir: dir, repoUrl: REPO, check: false });
        const readme = readFileSync(join(dir, "README.md"), "utf8");
        const rows = readme
            .split("\n")
            .filter((line) => line.startsWith("| 2026"));
        expect(rows).toEqual([
            `| 2026-08-01 | [Cap jobs per user \\| not globally](2026-08-01-fair-share.md) | infrastructure | accepted | [PR #20](${REPO}/pull/20), [PR #21](${REPO}/pull/21) |`,
            `| 2026-07-24 | [Claim jobs in Postgres](2026-07-24-claim-jobs.md) | infrastructure | accepted | [#12](${REPO}/issues/12), [PR #13](${REPO}/pull/13) |`,
        ]);
        expect(run({ adrDir: dir, repoUrl: REPO, check: true }).stale).toBe(
            false,
        );
    });

    it("fails on a missing front-matter field and leaves the index alone", () => {
        writeRecord("2026-07-24-claim-jobs.md", { kind: "<omit>" });
        const result = run({ adrDir: dir, repoUrl: REPO, check: false });
        expect(result.problems.map((problem) => problem.message)).toEqual([
            "missing front-matter field `kind`",
        ]);
        expect(result.written).toBe(false);
        expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(README);
    });

    it("fails when the filename date disagrees with date:", () => {
        writeRecord("2026-07-25-claim-jobs.md");
        expect(messages()).toEqual([
            "2026-07-25-claim-jobs.md: filename date 2026-07-25 disagrees with `date: 2026-07-24`",
        ]);
    });

    it("rejects bad values and unknown keys", () => {
        writeRecord("2026-07-24-claim-jobs.md", {
            status: "done",
            kind: "chore",
            updated: "2026-07-23",
            issues: "[#12]",
            areas: "[]",
            reviewers: "[someone]",
        });
        expect(messages()).toEqual([
            "2026-07-24-claim-jobs.md: unknown front-matter field `reviewers`",
            "2026-07-24-claim-jobs.md: `updated` `2026-07-23` is not a timestamp in `YYYY-MM-DD HH:MM` form",
            "2026-07-24-claim-jobs.md: `status` `done` is not one of: accepted, partially-implemented, proposed, superseded, rejected, reverted",
            "2026-07-24-claim-jobs.md: `kind` `chore` is not one of: feature, optimization, fix, refactor, infrastructure, process",
            "2026-07-24-claim-jobs.md: `areas` must name at least one path the decision lives in",
            "2026-07-24-claim-jobs.md: `issues` entry `#12` must be a plain number such as `123`",
        ]);
    });

    it("requires supersedes and relates links in both directions", () => {
        writeRecord("2026-07-24-claim-jobs.md");
        writeRecord("2026-08-01-fair-share.md", {
            date: "2026-08-01",
            updated: "2026-08-01 10:00",
            supersedes: "[2026-07-24-claim-jobs]",
            relates: "[2026-09-01-missing]",
        });
        expect(messages()).toEqual([
            "2026-08-01-fair-share.md: `supersedes` names `2026-07-24-claim-jobs`, but its `superseded-by` does not list `2026-08-01-fair-share`",
            "2026-08-01-fair-share.md: `relates` names `2026-09-01-missing`, which is not a record",
        ]);
    });

    it("accepts a mirrored supersession and shows it in the status column", () => {
        writeRecord("2026-07-24-claim-jobs.md", {
            status: "superseded",
            "superseded-by": "[2026-08-01-fair-share]",
        });
        writeRecord("2026-08-01-fair-share.md", {
            date: "2026-08-01",
            updated: "2026-08-01 10:00",
            supersedes: "[2026-07-24-claim-jobs]",
        });
        const result = run({ adrDir: dir, repoUrl: null, check: false });
        expect(result.problems).toEqual([]);
        expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(
            "| superseded by [2026-08-01-fair-share](2026-08-01-fair-share.md) | #12, PR #13 |",
        );
    });

    it("flags superseded status without superseded-by", () => {
        writeRecord("2026-07-24-claim-jobs.md", { status: "superseded" });
        expect(messages()).toEqual([
            "2026-07-24-claim-jobs.md: `status: superseded` needs the superseding record in `superseded-by`",
        ]);
    });

    it("reads campaign directories and rejects stray files", () => {
        mkdirSync(join(dir, "2026-07-24-pipeline-campaign"));
        writeFileSync(
            join(dir, "2026-07-24-pipeline-campaign", "README.md"),
            frontMatter(),
        );
        mkdirSync(join(dir, "2026-07-30-empty-campaign"));
        writeFileSync(join(dir, "notes.md"), "# stray\n");
        expect(messages()).toEqual([
            "2026-07-30-empty-campaign: record directory has no README.md",
            "notes.md: not a record: name it `YYYY-MM-DD-<slug>.md`, or `YYYY-MM-DD-<slug>/README.md` for a campaign",
        ]);
    });

    it("strips template comments but keeps quoted hashes", () => {
        const { fields, errors } = parseFrontMatter(
            [
                "---",
                'title: "Fix #12 parsing"   # quoted, so the hash stays',
                "date: 2026-07-24            # accepted",
                "areas: [src/lib/jobs]   # paths",
                "---",
            ].join("\n"),
        );
        expect(errors).toEqual([]);
        expect(fields.get("title")).toBe("Fix #12 parsing");
        expect(fields.get("date")).toBe("2026-07-24");
        expect(fields.get("areas")).toEqual(["src/lib/jobs"]);
    });

    it("derives the GitHub URL from package.json", () => {
        const pkg = join(dir, "package.json");
        writeFileSync(
            pkg,
            JSON.stringify({
                repository: {
                    type: "git",
                    url: "git+https://github.com/example/chatterbox.git",
                },
            }),
        );
        expect(repositoryUrl(pkg)).toBe(REPO);
        expect(repositoryUrl(join(dir, "missing.json"))).toBeNull();
    });
});
