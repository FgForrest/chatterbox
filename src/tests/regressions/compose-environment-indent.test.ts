/**
 * Every entry of a service's `environment:` block sits at one indentation.
 *
 * A line indented deeper than its siblings reads as the continuation of
 * the value above it, and `KEY: value` inside a plain scalar is a YAML
 * error: `docker compose` then refuses the whole file. There is no YAML
 * parser among the dependencies, so the indentation is checked directly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = [
    "docker-compose.yml",
    "docker-compose.dev.yml",
    "docker-compose.e2e.yml",
];

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** The entry lines of each `environment:` block, with their line numbers. */
function environmentBlocks(text: string) {
    const lines = text.split("\n");
    const blocks: { line: number; indent: number; text: string }[][] = [];
    for (const [index, line] of lines.entries()) {
        if (line.trim() !== "environment:") continue;
        const parent = indentOf(line);
        const entries = [];
        for (let next = index + 1; next < lines.length; next++) {
            const entry = lines[next] as string;
            if (!entry.trim() || entry.trim().startsWith("#")) continue;
            if (indentOf(entry) <= parent) break;
            entries.push({
                line: next + 1,
                indent: indentOf(entry),
                text: entry.trim(),
            });
        }
        blocks.push(entries);
    }
    return blocks;
}

describe("compose files: environment entries", () => {
    for (const file of FILES) {
        it(`${file} indents every environment entry alike`, () => {
            const text = readFileSync(join(process.cwd(), file), "utf8");
            for (const entries of environmentBlocks(text)) {
                const indent = entries[0]?.indent;
                const misplaced = entries
                    .filter((entry) => entry.indent !== indent)
                    .map((entry) => `${file}:${entry.line} ${entry.text}`);
                expect(misplaced).toEqual([]);
            }
        });
    }
});
