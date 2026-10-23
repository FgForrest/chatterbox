import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Copies the migration chain through `lastIdx`; the caller removes the temporary folder. */
export function migrationsThrough(lastIdx: number): string {
    const folder = mkdtempSync(join(tmpdir(), "chatterbox-migrations-"));
    cpSync(join(process.cwd(), "src/db/migrations"), folder, {
        recursive: true,
    });
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return folder;
}
