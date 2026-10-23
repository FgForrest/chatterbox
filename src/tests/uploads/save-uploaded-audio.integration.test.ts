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
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    processingProfiles,
    recordingFolders,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, nextId } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    let id = 0;
    return {
        dbRef: ref,
        nextId: () => `uploaded-${++id}`,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
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
vi.mock("nanoid", () => ({ nanoid: nextId }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "uploaded-audio-test-secret",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: undefined,
        ORG_ACCOUNT_PASSWORD: undefined,
        DEFAULT_STORAGE_TYPE: "local",
    },
}));
vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/uploads/audio-duration", () => ({
    readAudioDurationMs: vi.fn().mockResolvedValue(60_000),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/recordings/storage-reconciliation-job", () => ({
    enqueueStorageReconciliationJob: vi
        .fn()
        .mockResolvedValue({ created: true }),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/identity/factory", () => ({ isIdpAuthorization: () => false }));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgAccount: async () => false,
    isOrgScopeEnabled: () => false,
    isOrgScopeVisible: () => false,
}));

import { createFolder, ensureRootFolders } from "@/lib/folders/folders";
import { pipelineAdvanceJobHandler } from "@/lib/pipeline/advance-job";
import { ensureProfiles } from "@/lib/profiles/seed";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("uploaded audio filing gate (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let folderId = "";

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "uploaded_audio_filing_gate",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db().insert(users).values({
            id: "upload-user",
            email: "upload@example.test",
        });
        await ensureRootFolders("upload-user");
        await ensureProfiles("upload-user");
        const roots = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, "upload-user"));
        const rootId = roots[0]?.id;
        if (!rootId) throw new Error("missing private root");
        const folder = await createFolder({
            userId: "upload-user",
            parentId: rootId,
            name: "Filed",
        });
        folderId = folder.id;
        const [profile] = await db()
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, "upload-user"),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            )
            .limit(1);
        if (!profile) throw new Error("missing audio profile");
        await db().insert(folderDefaultProfiles).values({
            folderId,
            channel: "audio",
            profileId: profile.id,
        });
    }, 120_000);

    beforeEach(async () => {
        await db()
            .delete(itemProcessing)
            .where(eq(itemProcessing.userId, "upload-user"));
        await db()
            .delete(chatterItems)
            .where(eq(chatterItems.userId, "upload-user"));
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("categorizes a direct folder upload and leaves the pipeline runnable", async () => {
        const storage = {
            uploadFile: vi.fn().mockResolvedValue("stored"),
            deleteFile: vi.fn().mockResolvedValue(undefined),
        } as never;
        const { recordingId } = await saveUploadedAudio({
            userId: "upload-user",
            fileId: "folder-file",
            basename: "Filed",
            extension: ".mp3",
            buffer: Buffer.from("audio"),
            storage,
            sourceExtension: ".mp3",
            convertedFromVideo: false,
            folderId,
        });
        const [processing] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, recordingId),
                    eq(itemProcessing.userId, "upload-user"),
                ),
            );
        expect(processing?.phases.categorize).toMatchObject({
            state: "done",
            reason: "categorized",
        });
    });

    it("waits for a plain upload to be filed", async () => {
        const storage = {
            uploadFile: vi.fn().mockResolvedValue("stored"),
            deleteFile: vi.fn().mockResolvedValue(undefined),
        } as never;
        const { recordingId } = await saveUploadedAudio({
            userId: "upload-user",
            fileId: "plain-file",
            basename: "Inbox",
            extension: ".mp3",
            buffer: Buffer.from("audio"),
            storage,
            sourceExtension: ".mp3",
            convertedFromVideo: false,
        });
        await pipelineAdvanceJobHandler.run({
            jobId: "plain-upload-arrival",
            userId: "upload-user",
            payload: {
                itemId: recordingId,
                view: "private",
                reason: "arrival",
            },
            attempt: 1,
            maxAttempts: 10,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        });
        const [processing] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, recordingId),
                    eq(itemProcessing.userId, "upload-user"),
                ),
            );
        expect(processing?.phases.categorize).toMatchObject({
            state: "waiting",
            reason: "needs_folder",
        });
    });
});
