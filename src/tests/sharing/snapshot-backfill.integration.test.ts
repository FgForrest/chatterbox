/**
 * The backfill that gives recordings shared before snapshots existed their
 * Organization snapshot, against a real PostgreSQL.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    aiEnhancements,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, hooks } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        // Run once, before the next snapshot takes its locks.
        hooks: { beforeSnapshot: null as null | (() => Promise<void>) },
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: "organization-password" as string | undefined,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
// Something happening between the page read and the recording's lock.
vi.mock("@/lib/sharing/org-transcript", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/sharing/org-transcript")
    >("@/lib/sharing/org-transcript");
    return {
        ...actual,
        takeOrgSnapshot: async (
            ...args: Parameters<typeof actual.takeOrgSnapshot>
        ) => {
            const run = hooks.beforeSnapshot;
            hooks.beforeSnapshot = null;
            await run?.();
            return actual.takeOrgSnapshot(...args);
        },
    };
});

import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { backfillOrgSnapshots } from "@/lib/sharing/snapshot-backfill";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const DIALOG = "speaker_0: Hello.\nspeaker_1: Hi there.";
const DIARIZED = "gpt-4o-transcribe-diarize";

describeWithDatabase("the Organization snapshot backfill (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgRootId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "snapshot_backfill",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        hooks.beforeSnapshot = null;
        mockEnv.ORG_ACCOUNT_EMAIL = "org@example.test";
        mockEnv.ORG_ACCOUNT_PASSWORD = "organization-password";
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: OWNER, email: "owner@example.test" }]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        orgRootId = root?.id ?? "";
    });

    async function recording(id: string) {
        await db()
            .insert(recordings)
            .values({
                id,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: `plaud-${id}`,
                filename: encryptText(`Recording ${id}`),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/${id}.mp3`,
                plaudVersion: "1",
            });
    }

    async function transcript(
        recordingId: string,
        userId: string,
        source: string,
        text = DIALOG,
        revision = 0,
    ): Promise<string> {
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId,
                userId,
                text: encryptText(text),
                provider: "openai",
                model: DIARIZED,
                source,
                revision,
            })
            .returning({ id: transcriptions.id });
        return row?.id ?? "";
    }

    /** Shared the way it was before snapshots: an assignment, nothing copied. */
    async function sharedBeforeSnapshots(recordingId: string) {
        await db().insert(recordingFolderAssignments).values({
            userId: OWNER,
            recordingId,
            folderId: orgRootId,
        });
    }

    async function orgTranscripts(recordingId: string) {
        return db()
            .select()
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, orgUserId),
                ),
            );
    }

    async function marker(recordingId: string) {
        const [row] = await db()
            .select({ orgSnapshotAt: recordings.orgSnapshotAt })
            .from(recordings)
            .where(eq(recordings.id, recordingId));
        return row?.orgSnapshotAt ?? null;
    }

    it("fills a shared recording without a snapshot, then marks it", async () => {
        await recording("rec-a");
        const riffado = await transcript("rec-a", OWNER, "riffado");
        const [jana] = await db()
            .insert(people)
            .values({ userId: OWNER, displayName: encryptText("Jana") })
            .returning({ id: people.id });
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: riffado,
            label: "speaker_0",
            personId: jana?.id,
            source: "user",
            status: "confirmed",
            confirmedByUserId: OWNER,
        });
        await db()
            .insert(aiEnhancements)
            .values({
                recordingId: "rec-a",
                userId: OWNER,
                transcriptionId: riffado,
                summary: encryptText("What was said"),
                provider: "openai",
                model: "gpt",
                source: "riffado",
            });
        await sharedBeforeSnapshots("rec-a");

        expect(await backfillOrgSnapshots()).toBe(1);

        const [copy] = await orgTranscripts("rec-a");
        expect(copy?.producedByUserId).toBe(OWNER);
        const [named] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, copy?.id ?? ""));
        expect(named?.personId).toBe(jana?.id);
        const [promoted] = await db()
            .select({ userId: people.userId })
            .from(people)
            .where(eq(people.id, jana?.id ?? ""));
        expect(promoted?.userId).toBe(orgUserId);
        const [summary] = await db()
            .select()
            .from(aiEnhancements)
            .where(eq(aiEnhancements.userId, orgUserId));
        expect(summary?.transcriptionId).toBe(copy?.id);
        expect(await marker("rec-a")).not.toBeNull();

        // Marked: the next start finds nothing to do.
        expect(await backfillOrgSnapshots()).toBe(0);
    });

    it("leaves the Organization's own rows alone and fills only what is missing", async () => {
        await recording("rec-a");
        await transcript("rec-a", OWNER, "riffado");
        await transcript("rec-a", OWNER, "plaud");
        const own = await transcript(
            "rec-a",
            orgUserId,
            "riffado",
            "speaker_0: The Organization's own.",
            7,
        );
        await sharedBeforeSnapshots("rec-a");

        await backfillOrgSnapshots();

        const rows = await orgTranscripts("rec-a");
        expect(rows.map((row) => row.source).sort()).toEqual([
            "plaud",
            "riffado",
        ]);
        const riffado = rows.find((row) => row.source === "riffado");
        expect(riffado?.id).toBe(own);
        expect(riffado?.revision).toBe(7);
        expect(await marker("rec-a")).not.toBeNull();
    });

    it("never refills a snapshot Organization retention reaped", async () => {
        await recording("rec-a");
        await transcript("rec-a", OWNER, "riffado", "Hello.", 0);
        await db()
            .update(transcriptions)
            .set({ model: "whisper-1" })
            .where(eq(transcriptions.recordingId, "rec-a"));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: "rec-a",
            folderId: orgRootId,
        });
        await db()
            .delete(transcriptions)
            .where(eq(transcriptions.userId, orgUserId));

        expect(await backfillOrgSnapshots()).toBe(0);
        expect(await orgTranscripts("rec-a")).toEqual([]);
    });

    it("skips a recording unshared between the page read and its lock", async () => {
        await recording("rec-a");
        await transcript("rec-a", OWNER, "riffado");
        await sharedBeforeSnapshots("rec-a");
        hooks.beforeSnapshot = () => unshareRecording(OWNER, "rec-a");

        await backfillOrgSnapshots();

        expect(await orgTranscripts("rec-a")).toEqual([]);
        expect(await marker("rec-a")).toBeNull();
    });

    it("copies nothing twice when two processes run it at once", async () => {
        for (const id of ["rec-a", "rec-b", "rec-c"]) {
            await recording(id);
            await transcript(id, OWNER, "riffado");
            await transcript(id, OWNER, "plaud");
            await sharedBeforeSnapshots(id);
        }

        await Promise.all([backfillOrgSnapshots(), backfillOrgSnapshots()]);

        for (const id of ["rec-a", "rec-b", "rec-c"]) {
            expect(
                (await orgTranscripts(id)).map((row) => row.source).sort(),
            ).toEqual(["plaud", "riffado"]);
            expect(await marker(id)).not.toBeNull();
        }
    });

    it("does nothing while the Organization scope is read-only", async () => {
        await recording("rec-a");
        await transcript("rec-a", OWNER, "riffado");
        await sharedBeforeSnapshots("rec-a");
        mockEnv.ORG_ACCOUNT_EMAIL = undefined;
        mockEnv.ORG_ACCOUNT_PASSWORD = undefined;

        expect(await backfillOrgSnapshots()).toBe(0);
        expect(await orgTranscripts("rec-a")).toEqual([]);
    });
});
