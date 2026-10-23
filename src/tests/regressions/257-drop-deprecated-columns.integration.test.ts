import { rmSync } from "node:fs";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import unzipper from "unzipper";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { warnPendingRecordingColumnDrop } from "@/db/queries/migration-warnings";
import { chatterItems, recordings, users } from "@/db/schema";
import { migrationsThrough } from "@/tests/integration/migrations";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    migrateTestDatabase,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, dbProxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property) => {
                    if (!ref.current)
                        throw new Error("test database was not initialized");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "personal",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { decryptText, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import type { StorageProvider } from "@/lib/storage/types";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER_ID = "archive-owner";
const RECORDING_ID = "archive-recording";
const DROPPED_COLUMNS = [
    "filename",
    "start_time",
    "title_edited_at",
    "summary_due_at",
    "transcript_reaped_at",
    "summary_reaped_at",
    "unshared_at",
];
const ITEM_TIME = new Date("2026-10-02T12:34:56.789Z");

describeWithDatabase("#257 deprecated recording column removal", () => {
    let database: TestPostgresDatabase | null = null;
    let previousMigrations = "";
    let before: typeof chatterItems.$inferSelect;

    function currentDatabase() {
        if (!database) throw new Error("test database was not initialized");
        return database;
    }

    beforeAll(async () => {
        previousMigrations = migrationsThrough(140);
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "drop_deprecated_columns",
            previousMigrations,
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await database.db
            .insert(users)
            .values({ id: USER_ID, email: "owner@example.com" });
        const [item] = await database.db
            .insert(chatterItems)
            .values({
                id: RECORDING_ID,
                userId: USER_ID,
                kind: "audio",
                title: encryptText("Current title"),
                occurredAt: ITEM_TIME,
                titleEditedAt: ITEM_TIME,
                summaryDueAt: ITEM_TIME,
                contentReapedAt: ITEM_TIME,
                summaryReapedAt: ITEM_TIME,
                createdAt: ITEM_TIME,
                updatedAt: ITEM_TIME,
            })
            .returning();
        if (!item) throw new Error("item fixture was not inserted");
        before = item;
        const frozenTitle = encryptText("Frozen title");
        const frozenTime = new Date("2026-09-01T10:00:00Z").toISOString();
        await database.sql`
            INSERT INTO recordings (
                id, user_id, device_sn, plaud_file_id, duration, end_time,
                filesize, file_md5, storage_type, storage_path, plaud_version,
                filename, start_time, title_edited_at, summary_due_at,
                transcript_reaped_at, summary_reaped_at, unshared_at
            ) VALUES (
                ${RECORDING_ID}, ${USER_ID}, 'local', 'archive-source', 1000,
                ${ITEM_TIME.toISOString()}::timestamp, 0, ${"0".repeat(32)},
                'local', 'archive-owner/recording.mp3', '1', ${frozenTitle},
                ${frozenTime}::timestamp, ${frozenTime}::timestamp,
                ${frozenTime}::timestamp, ${frozenTime}::timestamp,
                ${frozenTime}::timestamp, ${frozenTime}::timestamp
            )
        `;
        const oldColumns = await database.sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'recordings'
        `;
        expect(oldColumns.map((row) => row.column_name)).toEqual(
            expect.arrayContaining(DROPPED_COLUMNS),
        );
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await warnPendingRecordingColumnDrop(database.sql);
            expect(warning).toHaveBeenCalledExactlyOnceWith(
                expect.stringContaining(
                    "rollback to an older image requires restoring that dump",
                ),
            );
        } finally {
            warning.mockRestore();
        }
        await migrateTestDatabase(testDatabaseUrl ?? "", database.db);
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        if (previousMigrations)
            rmSync(previousMigrations, { recursive: true, force: true });
    }, 30_000);

    it("drops all seven columns and their obsolete index", async () => {
        const columns = await currentDatabase().sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'recordings'
        `;
        expect(
            columns
                .map((row) => row.column_name)
                .filter((name) => DROPPED_COLUMNS.includes(name)),
        ).toEqual([]);
        const indexes = await currentDatabase().sql`
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'recordings'
        `;
        expect(indexes.map((row) => row.indexname)).not.toContain(
            "recordings_user_id_start_time_idx",
        );
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await warnPendingRecordingColumnDrop(currentDatabase().sql);
            expect(warning).not.toHaveBeenCalled();
        } finally {
            warning.mockRestore();
        }
    });

    it("keeps the current encrypted title and every item timestamp", async () => {
        const [after] = await currentDatabase()
            .db.select()
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, RECORDING_ID),
                    eq(chatterItems.userId, USER_ID),
                ),
            );
        expect(after).toEqual(before);
        expect(decryptText(after?.title ?? "")).toBe("Current title");
        const audio = await currentDatabase()
            .db.select()
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, RECORDING_ID),
                    eq(recordings.userId, USER_ID),
                ),
            );
        expect(audio).toHaveLength(1);
    });

    it("exports the migrated item through the existing 2.4 archive format", async () => {
        let archive = Buffer.alloc(0);
        const storage: StorageProvider = {
            exists: vi.fn().mockResolvedValue(false),
            uploadFile: vi.fn(),
            downloadFile: vi.fn(),
            downloadStream: vi.fn(),
            getSignedUrl: vi.fn(),
            deleteFile: vi.fn(),
            testConnection: vi.fn(),
            uploadStream: async (key: string, stream: Readable) => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk));
                archive = Buffer.concat(chunks);
                return key;
            },
        };
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: USER_ID },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "backup.zip",
        });
        const zip = await unzipper.Open.buffer(archive);
        const file = zip.files.find((entry) => entry.path === "manifest.json");
        if (!file) throw new Error("archive has no manifest");
        const manifest = JSON.parse((await file.buffer()).toString("utf8"));
        expect(manifest.version).toBe("2.4");
        expect(manifest.recordings).toHaveLength(1);
        expect(manifest.recordings[0]).toMatchObject({
            id: RECORDING_ID,
            filename: "Current title",
            startTime: ITEM_TIME.toISOString(),
        });
        for (const column of DROPPED_COLUMNS.filter(
            (name) => name !== "filename",
        )) {
            expect(manifest.recordings[0]).not.toHaveProperty(column);
        }
        expect(JSON.stringify(manifest)).not.toContain("Frozen title");
    });
});
