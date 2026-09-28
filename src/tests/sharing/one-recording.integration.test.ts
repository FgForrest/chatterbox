/**
 * A shared recording is one recording, against a real PostgreSQL: the
 * Organization view reads the owner's rows, only the organization account
 * changes them while it is shared, and a withdrawal gives them back to the
 * owner as the Organization left them.
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
    recordingFolders,
    recordings,
    transcriptions,
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
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        exists: vi.fn().mockResolvedValue(false),
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));
// The files already carry the name; renaming them is not what is tested.
vi.mock("@/lib/recordings/reconcile-storage", () => ({
    reconcileRecordingStorage: vi.fn(
        async (state: { storagePath: string; storageFilename: string }) => ({
            changed: false,
            storagePath: state.storagePath,
            storageFilename: state.storageFilename,
        }),
    ),
}));
vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return { user: { id, email: `${id}@example.test` } };
        }),
    };
});

import { POST as postEraseRoute } from "@/app/api/recordings/[id]/erase/route";
import { PATCH as patchRecordingRoute } from "@/app/api/recordings/[id]/route";
import {
    DELETE as deleteSummaryRoute,
    GET as getSummaryRoute,
    POST as postSummaryRoute,
} from "@/app/api/recordings/[id]/summary/route";
import { POST as postTopicsRoute } from "@/app/api/recordings/[id]/topics/route";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import { upsertEnhancement } from "@/lib/transcription/persist";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-one";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function call(
    handler: unknown,
    user: string,
    {
        view,
        method = "GET",
        path = "summary",
        body,
    }: { view?: "org"; method?: string; path?: string; body?: object } = {},
) {
    const url = `http://localhost/api/recordings/${REC}${path ? `/${path}` : ""}${view ? "?view=org" : ""}`;
    return (handler as Handler)(
        new Request(url, {
            method,
            headers: {
                "content-type": "application/json",
                "x-test-user": user,
            },
            ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        }),
        { params: Promise.resolve({ id: REC }) },
    );
}

describeWithDatabase("a shared recording is one recording (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "one_recording",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await db()
            .insert(recordings)
            .values({
                id: REC,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/rec.mp3`,
                storageFilename: "rec.mp3",
                plaudVersion: "1",
            });
        // No speakers, so nothing stands in the way of sharing it.
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText("What was said."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        await db()
            .insert(aiEnhancements)
            .values({
                recordingId: REC,
                userId: OWNER,
                transcriptionId: transcript?.id,
                summary: encryptText("The owner's summary."),
                provider: "openai",
                model: "gpt",
                source: "riffado",
            });
    });

    async function share() {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
    }

    async function summaries() {
        return db()
            .select({ userId: aiEnhancements.userId })
            .from(aiEnhancements)
            .where(eq(aiEnhancements.recordingId, REC));
    }

    it("shows every member the owner's summary on the Organization view", async () => {
        await share();

        const response = await call(getSummaryRoute, BOB, { view: "org" });

        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.summary).toBe("The owner's summary.");
        expect(body).not.toHaveProperty("fallback");
    });

    it("lets neither a member nor the owner generate or delete its summary while shared", async () => {
        await share();

        for (const method of ["POST", "DELETE"]) {
            const handler =
                method === "POST" ? postSummaryRoute : deleteSummaryRoute;
            const member = await call(handler, BOB, { view: "org", method });
            expect(member.status).toBe(403);
            const owner = await call(handler, OWNER, { method });
            expect(owner.status).toBe(409);
            await expect(owner.json()).resolves.toMatchObject({
                code: "RECORDING_SHARED",
            });
        }
        expect(await summaries()).toEqual([{ userId: OWNER }]);
    });

    it("lets the organization account delete it, for the owner too", async () => {
        await share();

        const response = await call(deleteSummaryRoute, orgUserId, {
            view: "org",
            method: "DELETE",
        });

        expect(response.status).toBe(200);
        expect(await summaries()).toEqual([]);
    });

    it("gives the owner back what is left after a withdrawal, to change again", async () => {
        await share();
        await unshareRecording(OWNER, REC);

        expect(
            (await call(deleteSummaryRoute, orgUserId, { method: "DELETE" }))
                .status,
        ).toBe(404);
        const owner = await call(deleteSummaryRoute, OWNER, {
            method: "DELETE",
        });
        expect(owner.status).toBe(200);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.recordingId, REC),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                ),
        ).toEqual([]);
    });

    it("keeps the title and topics the organization account's while shared", async () => {
        await share();

        const rename = await call(patchRecordingRoute, OWNER, {
            method: "PATCH",
            path: "",
            body: { filename: "Renamed" },
        });
        expect(rename.status).toBe(409);
        await expect(rename.json()).resolves.toMatchObject({
            code: "RECORDING_SHARED",
        });
        const topics = await call(postTopicsRoute, OWNER, {
            method: "POST",
            path: "topics",
        });
        expect(topics.status).toBe(409);
        // An automatic detection queued before the share has nothing to do.
        expect(
            await topicsJobHandler.run({
                payload: {
                    recordingId: REC,
                    source: "riffado",
                    trigger: "auto",
                },
                userId: OWNER,
                reportProgress: () => {},
            } as unknown as Parameters<typeof topicsJobHandler.run>[0]),
        ).toEqual({ skipped: "shared" });

        await unshareRecording(OWNER, REC);
        const renamed = await call(patchRecordingRoute, OWNER, {
            method: "PATCH",
            path: "",
            body: { filename: "Renamed" },
        });
        expect(renamed.status).toBe(200);
    });

    it("erases a shared recording only by taking it out of the Organization first", async () => {
        await share();
        const erase = (body: object) =>
            call(postEraseRoute, OWNER, {
                method: "POST",
                path: "erase",
                body,
            });

        const refused = await erase({ scope: "transcript" });
        expect(refused.status).toBe(409);
        await expect(refused.json()).resolves.toMatchObject({
            code: "RECORDING_SHARED",
        });
        expect(await resolveRecordingAccess(BOB, REC)).not.toBeNull();

        const erased = await erase({ scope: "transcript", withdraw: true });
        expect(erased.status).toBe(200);
        // Withdrawn and erased together: nobody but the owner sees it, and
        // its transcript is gone.
        expect(await resolveRecordingAccess(BOB, REC)).toBeNull();
        expect(
            await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC)),
        ).toEqual([]);
    });
    it("lets only the writer of the moment store a summary", async () => {
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        const store = (actorUserId: string) =>
            upsertEnhancement({
                userId: OWNER,
                actorUserId,
                recordingId: REC,
                transcriptionId: transcript?.id ?? "",
                summary: `by ${actorUserId}`,
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                provider: "openai",
                model: "gpt",
            });
        await share();

        expect(await store(OWNER)).toEqual({
            committed: false,
            reason: "shared",
        });
        expect(await store(BOB)).toEqual({
            committed: false,
            reason: "shared",
        });
        expect(await store(orgUserId)).toEqual({ committed: true });

        await unshareRecording(OWNER, REC);
        expect(await store(orgUserId)).toEqual({
            committed: false,
            reason: "withdrawn",
        });
        expect(await store(OWNER)).toEqual({ committed: true });
    });
});
