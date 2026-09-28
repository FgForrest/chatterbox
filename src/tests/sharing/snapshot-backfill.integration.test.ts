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

import { db as appDb } from "@/db";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeople, promotePersonInTx } from "@/lib/knowledge/people";
import { ensureOrgAccount } from "@/lib/org/account";
import { takeOrgSnapshot } from "@/lib/sharing/org-transcript";
import { backfillOrgSnapshots } from "@/lib/sharing/snapshot-backfill";

type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/** A transaction held open, with its locks, until `commit`. */
async function holdTransaction(work: (tx: Tx) => Promise<void>) {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let ready = () => {};
    const worked = new Promise<void>((resolve) => {
        ready = resolve;
    });
    const done = appDb.transaction(async (tx) => {
        await work(tx);
        ready();
        await released;
    });
    await Promise.race([worked, done]);
    return {
        commit: async () => {
            release();
            await done;
        },
    };
}

/** Whether `promise` is still pending after a moment: waiting on a lock. */
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol("pending");
    const first = await Promise.race([
        promise.then(
            () => null,
            () => null,
        ),
        new Promise((resolve) => setTimeout(() => resolve(pending), 300)),
    ]);
    return first === pending;
}

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const OTHER = "user-other";
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

    async function recording(id: string, ownerId = OWNER) {
        await db()
            .insert(recordings)
            .values({
                id,
                userId: ownerId,
                deviceSn: "SN-1",
                plaudFileId: `plaud-${id}`,
                filename: encryptText(`Recording ${id}`),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${ownerId}/${id}.mp3`,
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
    async function sharedBeforeSnapshots(recordingId: string, ownerId = OWNER) {
        await db().insert(recordingFolderAssignments).values({
            userId: ownerId,
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

    it("folds a second owner's record with the same email into the Organization person a concurrent promotion makes", async () => {
        await db()
            .insert(users)
            .values([{ id: OTHER, email: "other@example.test" }]);
        const named: string[] = [];
        for (const [id, ownerId] of [
            ["rec-a", OWNER],
            ["rec-b", OTHER],
        ] as const) {
            await recording(id, ownerId);
            const own = await transcript(id, ownerId, "riffado");
            const [person] = await db()
                .insert(people)
                .values({
                    userId: ownerId,
                    displayName: encryptText("Jana"),
                    primaryEmail: encryptText("jana@example.test"),
                    primaryEmailHash: lookupHash("jana@example.test"),
                })
                .returning({ id: people.id });
            named.push(person?.id ?? "");
            for (const label of ["speaker_0", "speaker_1"]) {
                await db()
                    .insert(transcriptSpeakers)
                    .values({
                        userId: ownerId,
                        transcriptionId: own,
                        label,
                        personId: label === "speaker_0" ? person?.id : null,
                        markedUnknown: label !== "speaker_0",
                        source: "user",
                        status: "confirmed",
                        confirmedByUserId: ownerId,
                    });
            }
            await sharedBeforeSnapshots(id, ownerId);
        }

        // Another share, promoting the first owner's Jana, holds its
        // transaction open: the second snapshot's promotion must wait for
        // it and fold its Jana into that one, or it makes a second
        // Organization Jana with the same email and fails.
        const first = await holdTransaction(async (tx) => {
            await lockOrgPeople(tx);
            await promotePersonInTx(tx, named[0] ?? "", orgUserId);
        });
        const second = takeOrgSnapshot("rec-b", {
            ownerUserId: OTHER,
            contentUserId: orgUserId,
        });
        expect(await stillWaiting(second)).toBe(true);
        await first.commit();
        expect(await second).toBe(true);
        await takeOrgSnapshot("rec-a", {
            ownerUserId: OWNER,
            contentUserId: orgUserId,
        });

        const orgPeople = await db()
            .select({ id: people.id })
            .from(people)
            .where(eq(people.userId, orgUserId));
        expect(orgPeople).toHaveLength(1);
        const names = await db()
            .select({ personId: transcriptSpeakers.personId })
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.userId, orgUserId),
                    eq(transcriptSpeakers.label, "speaker_0"),
                ),
            );
        expect(names.map((row) => row.personId)).toEqual([
            orgPeople[0]?.id,
            orgPeople[0]?.id,
        ]);
        expect(named).toContain(orgPeople[0]?.id);
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
