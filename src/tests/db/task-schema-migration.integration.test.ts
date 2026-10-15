/**
 * The task schema and legacy-task backfill against a populated database.
 *
 * The database is migrated through the last migration before Task 4.2,
 * seeded with existing tasks, and then migrated through the new schema and
 * data steps.
 */

import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    migrateTestDatabase,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const MIGRATIONS = join(process.cwd(), "src/db/migrations");
const LAST_BEFORE_TASK_SCHEMA = 120;
const BACKFILL_MIGRATION = "0122_backfill_task_mentions.sql";

function migrationsUpTo(lastIdx: number): string {
    const dir = mkdtempSync(join(tmpdir(), "chatterbox-task-schema-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
}

describeWithDatabase("task schema migration (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let partialFolder = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        partialFolder = migrationsUpTo(LAST_BEFORE_TASK_SCHEMA);
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "task_schema",
            partialFolder,
        );

        await db().execute(sql`
            INSERT INTO users (id, email, role) VALUES
                ('owner', 'owner@example.test', 'user'),
                ('org', 'org@example.test', 'org')
        `);
        await db().execute(sql`
            INSERT INTO chatter_items (
                id, user_id, kind, title, occurred_at, created_at
            ) VALUES
                ('shared-item', 'owner', 'audio', 'enc:shared',
                 '2026-10-01 09:00:00', '2026-10-01 09:05:00'),
                ('private-item', 'owner', 'audio', 'enc:private',
                 '2026-10-02 10:00:00', '2026-10-02 10:05:00')
        `);
        await db().execute(sql`
            INSERT INTO recordings (
                id, user_id, device_sn, plaud_file_id, duration, end_time,
                filesize, file_md5, storage_type, storage_path, plaud_version
            ) VALUES
                ('shared-item', 'owner', 'SN', 'shared', 1000, now(), 1,
                 ${"0".repeat(32)}, 'local', 'owner/shared.mp3', '1'),
                ('private-item', 'owner', 'SN', 'private', 1000, now(), 1,
                 ${"1".repeat(32)}, 'local', 'owner/private.mp3', '1')
        `);
        await db().execute(sql`
            INSERT INTO transcriptions (
                id, recording_id, user_id, text, provider, model, source, revision
            ) VALUES
                ('shared-content', 'shared-item', 'owner', 'enc:transcript',
                 'openai', 'whisper-1', 'riffado', 3),
                ('private-content', 'private-item', 'owner', 'enc:transcript',
                 'openai', 'whisper-1', 'riffado', 4)
        `);
        await db().execute(sql`
            INSERT INTO recording_folders (
                id, user_id, parent_id, name, name_hash, kind
            ) VALUES
                ('org-root', 'org', NULL, 'enc:Organization', 'org-root', 'public'),
                ('org-folder', 'org', 'org-root', 'enc:Team', 'org-team', 'custom')
        `);
        await db().execute(sql`
            INSERT INTO recording_folder_assignments (
                user_id, recording_id, folder_id
            ) VALUES ('owner', 'shared-item', 'org-folder')
        `);
        await db().execute(sql`
            INSERT INTO recording_tasks (
                id, recording_id, user_id, status, text, quote,
                evidence_start_ms, evidence_provenance, source,
                accepted_at, status_changed_at, created_at
            ) VALUES
                ('shared-task', 'shared-item', 'owner', 'open', 'enc:task-one',
                 'enc:quote-one', 1250, 'unverified', 'riffado',
                 '2026-10-01 11:00:00', '2026-10-01 12:00:00',
                 '2026-10-01 10:00:00'),
                ('private-task', 'private-item', 'owner', 'proposed', 'enc:task-two',
                 'enc:quote-two', NULL, 'quoted', 'riffado', NULL, NULL,
                 '2026-10-02 11:00:00'),
                ('mismatched-task', 'shared-item', 'org', 'open', 'enc:task-three',
                 'enc:quote-three', 2500, 'unverified', 'riffado',
                 '2026-10-03 11:00:00', '2026-10-03 12:00:00',
                 '2026-10-03 10:00:00')
        `);
        await db().execute(sql`
            UPDATE recording_tasks
            SET evidence_segment_index = 2,
                evidence_char_start = 5,
                evidence_char_end = 17
            WHERE id = 'private-task'
        `);
        await db().execute(sql`
            INSERT INTO task_update_proposals (
                id, task_id, recording_id, user_id, kind
            ) VALUES (
                'existing-update', 'shared-task', 'shared-item', 'owner', 'done'
            )
        `);

        await migrateTestDatabase(testDatabaseUrl ?? "", db());
    }, 240_000);

    afterAll(async () => {
        await database?.dispose();
        if (partialFolder) {
            rmSync(partialFolder, { recursive: true, force: true });
        }
    }, 30_000);

    it("backfills one mention per existing task with evidence and chronology", async () => {
        const mentions = await db().execute<Record<string, unknown>>(sql`
            SELECT task_id, item_id, user_id, view, quote, provenance,
                   evidence_start_ms, evidence_segment_index,
                   evidence_char_start, evidence_char_end,
                   content_source_id, content_revision, statement_at,
                   match_decision
            FROM task_mentions
            ORDER BY task_id
        `);
        expect(mentions).toHaveLength(3);
        expect(mentions[0]).toMatchObject({
            task_id: "mismatched-task",
            item_id: "shared-item",
            user_id: "owner",
            view: "org",
            quote: "enc:quote-three",
            provenance: "unverified",
            evidence_start_ms: 2500,
            content_source_id: "riffado",
            content_revision: 3,
            match_decision: "home",
        });
        expect(String(mentions[0]?.statement_at)).toContain("2026-10-01");
        expect(mentions[1]).toMatchObject({
            task_id: "private-task",
            item_id: "private-item",
            user_id: "owner",
            view: "private",
            quote: "enc:quote-two",
            provenance: "quoted",
            evidence_start_ms: null,
            evidence_segment_index: 2,
            evidence_char_start: 5,
            evidence_char_end: 17,
            content_source_id: "riffado",
            content_revision: 4,
            match_decision: "home",
        });
        expect(String(mentions[1]?.statement_at)).toContain("2026-10-02");
        expect(mentions[2]).toMatchObject({
            task_id: "shared-task",
            item_id: "shared-item",
            user_id: "owner",
            view: "org",
            quote: "enc:quote-one",
            provenance: "unverified",
            evidence_start_ms: 1250,
            evidence_segment_index: null,
            evidence_char_start: null,
            evidence_char_end: null,
            content_source_id: "riffado",
            content_revision: 3,
            match_decision: "home",
        });
        expect(String(mentions[2]?.statement_at)).toContain("2026-10-01");

        const mismatchedMentions = await db().execute<{
            user_id: string;
        }>(sql`
            SELECT user_id
            FROM task_mentions
            WHERE task_id = 'mismatched-task'
        `);
        expect(mismatchedMentions).toEqual([{ user_id: "owner" }]);

        const [taskWithoutMention] = await db().execute<{ count: number }>(sql`
            SELECT count(*)::int AS count
            FROM recording_tasks AS task
            WHERE NOT EXISTS (
                SELECT 1
                FROM task_mentions AS mention
                WHERE mention.task_id = task.id
            )
        `);
        expect(taskWithoutMention?.count).toBe(0);

        const tasks = await db().execute<Record<string, unknown>>(sql`
            SELECT id, origin_item_id, status_effective_at
            FROM recording_tasks
            ORDER BY id
        `);
        expect(tasks[0]).toMatchObject({
            id: "mismatched-task",
            origin_item_id: "shared-item",
        });
        expect(String(tasks[0]?.status_effective_at)).toContain("2026-10-03");
        expect(tasks[1]).toMatchObject({
            id: "private-task",
            origin_item_id: "private-item",
            status_effective_at: null,
        });
        expect(tasks[2]).toMatchObject({
            id: "shared-task",
            origin_item_id: "shared-item",
        });
        expect(String(tasks[2]?.status_effective_at)).toContain("2026-10-01");

        const [update] = await db().execute<{ state: string }>(sql`
            SELECT state
            FROM task_update_proposals
            WHERE id = 'existing-update'
        `);
        expect(update?.state).toBe("awaiting_source_review");
    });

    it("is a no-op when the data step runs twice", async () => {
        if (!database) throw new Error("test database was not initialized");
        const migration = readFileSync(
            join(MIGRATIONS, BACKFILL_MIGRATION),
            "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await database.sql.unsafe(statement);
        }
        const [row] = await db().execute<{ count: number }>(sql`
            SELECT count(*)::int AS count FROM task_mentions
        `);
        expect(row?.count).toBe(3);
    });

    it("enforces anchor, proposal kind, and proposal state checks", async () => {
        await expect(
            db().execute(sql`
                INSERT INTO task_mentions (
                    id, task_id, item_id, user_id, view,
                    evidence_start_ms, evidence_segment_index,
                    evidence_char_start, evidence_char_end,
                    statement_at, match_decision
                ) VALUES (
                    'bad-anchor', 'shared-task', 'shared-item', 'owner',
                    'org', 1, 0, 0, 1, now(), 'accepted'
                )
            `),
        ).rejects.toThrow();
        await expect(
            db().execute(sql`
                INSERT INTO task_update_proposals (
                    id, task_id, recording_id, user_id, kind
                ) VALUES (
                    'bad-kind', 'shared-task', 'shared-item', 'owner', 'drop'
                )
            `),
        ).rejects.toThrow();
        await expect(
            db().execute(sql`
                INSERT INTO task_update_proposals (
                    id, task_id, recording_id, user_id, kind, state
                ) VALUES (
                    'bad-state', 'shared-task', 'shared-item', 'owner',
                    'done', 'waiting'
                )
            `),
        ).rejects.toThrow();
        await expect(
            db().execute(sql`
                INSERT INTO task_update_proposals (
                    id, task_id, recording_id, user_id, kind
                ) VALUES (
                    'due-phrase', 'shared-task', 'shared-item', 'owner',
                    'due_phrase'
                )
            `),
        ).resolves.toBeDefined();
        await expect(
            db().execute(sql`
                INSERT INTO task_update_proposals (
                    id, task_id, recording_id, user_id, kind
                ) VALUES (
                    'missing-date', 'shared-task', 'shared-item', 'owner', 'due'
                )
            `),
        ).rejects.toThrow();
    });

    it("cascades task-owned schema rows when a task is deleted", async () => {
        await db().execute(sql`
            INSERT INTO task_home_moves (id, task_id, reason)
            VALUES ('move', 'shared-task', 'deleted')
        `);
        await db().execute(sql`
            INSERT INTO task_vectors (
                id, user_id, task_id, vector_generation, dim, vector, input_hmac
            ) VALUES (
                'vector', 'owner', 'shared-task', 'test-v1', 2,
                'enc:vector', ${"a".repeat(64)}
            )
        `);
        await db().execute(sql`
            DELETE FROM recording_tasks WHERE id = 'shared-task'
        `);
        const [row] = await db().execute<{
            mentions: number;
            moves: number;
            vectors: number;
        }>(sql`
            SELECT
                (SELECT count(*)::int FROM task_mentions WHERE task_id = 'shared-task') AS mentions,
                (SELECT count(*)::int FROM task_home_moves WHERE task_id = 'shared-task') AS moves,
                (SELECT count(*)::int FROM task_vectors WHERE task_id = 'shared-task') AS vectors
        `);
        expect(row).toEqual({ mentions: 0, moves: 0, vectors: 0 });
    });
});
