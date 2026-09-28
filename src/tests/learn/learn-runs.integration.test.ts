/**
 * Learn runs against a real PostgreSQL: what happens to them when their
 * transcript is rewritten, and when their recording leaves the
 * Organization.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
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
    learnReviewItems,
    learnRuns,
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

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-learn";
const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Dobrý den." },
];

describeWithDatabase("Learn runs (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_runs",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        orgUserId = (await ensureOrgAccount()) ?? "";
        await db()
            .insert(recordings)
            .values({
                id: REC,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 5_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:00:05Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/rec.mp3`,
                plaudVersion: "1",
            });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText(TURNS[0]?.text ?? ""),
                turns: encryptJsonField(TURNS),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: null,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: OWNER,
        });
    });

    function run(
        view: "private" | "org",
        status: "queued" | "running" | "ready" | "finished",
    ) {
        return db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: view === "org" ? orgUserId : OWNER,
                recordingId: REC,
                transcriptionId: transcriptId,
                view,
                actorUserId: view === "org" ? orgUserId : OWNER,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status,
            })
            .returning({ id: learnRuns.id })
            .then((rows) => rows[0]?.id ?? "");
    }

    const statusOf = async (id: string) =>
        (
            await db()
                .select({ status: learnRuns.status })
                .from(learnRuns)
                .where(eq(learnRuns.id, id))
        )[0]?.status;

    it("supersedes the pending runs of a transcript that is rewritten, and leaves finished ones", async () => {
        const queued = await run("private", "queued");
        const ready = await run("private", "ready");
        const finished = await run("private", "finished");

        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Dobrý den všem.",
            detectedLanguage: "cs",
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-transcribe-diarize",
            turns: [
                { ...(TURNS[0] as TranscriptTurn), text: "Dobrý den všem." },
            ],
        });

        expect(await statusOf(queued)).toBe("superseded");
        expect(await statusOf(ready)).toBe("superseded");
        expect(await statusOf(finished)).toBe("finished");
    });

    it("takes the Organization's runs, and what they proposed, with the recording when it leaves", async () => {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
        const orgs = await run("org", "ready");
        await db()
            .insert(learnReviewItems)
            .values({
                runId: orgs,
                userId: orgUserId,
                kind: "fact",
                fingerprintHmac: "f",
                payload: encryptJsonField({ secret: "what the curator found" }),
            });

        await unshareRecording(OWNER, REC);

        expect(await statusOf(orgs)).toBeUndefined();
        expect(await db().select().from(learnReviewItems)).toEqual([]);
    });
});
