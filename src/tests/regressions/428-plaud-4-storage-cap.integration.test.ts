import { createHash } from "node:crypto";
import { eq, sum } from "drizzle-orm";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { GET as getPlaudInfo } from "@/app/api/dev/plaud/info/route";
import { POST as manualSync } from "@/app/api/plaud/sync/route";
import { POST as eraseRecording } from "@/app/api/recordings/[id]/erase/route";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { ErrorCode } from "@/lib/errors";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import { PLAUD_SERVERS } from "@/lib/plaud/servers";
import { mapPlaudV4Item } from "@/lib/plaud/v4";
import { reapRecording } from "@/lib/retention/reap";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type * as SyncModule from "@/lib/sync/sync-recordings";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import {
    insertRecordings,
    type TestRecordingInsert,
} from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import type { PlaudV4FileMeta, PlaudV4RecordingItem } from "@/types/plaud";

const mocks = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        proxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        storage: {
            uploadFile: vi.fn(),
            deleteFile: vi.fn(),
        },
    };
});

vi.mock("@/db", () => ({ db: mocks.proxy }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "test-owner" } }),
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async () => false,
}));
vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: async () => null,
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "solo",
        DEFAULT_STORAGE_TYPE: "local",
        PLAUD_SYNC_RATE_LIMIT_PER_MINUTE: 10,
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));
vi.mock("@/lib/hosted/billing/storage-cap", () => ({
    enforceStorageCap: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => mocks.storage,
    createStorageProvider: () => mocks.storage,
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: vi.fn() }));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const USER = "test-owner";
const API = PLAUD_SERVERS.eu.apiBase;
const WORKSPACE = "ws_test";
const CAP = 100;
const AUDIO_URL = "https://audio.example.com/recording.mp3";
const AUDIO = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(57)]);
const AUDIO_MD5 = createHash("md5").update(AUDIO).digest("hex");
const OLD_OGG = `${USER}/Original.ogg`;

function v4Item(
    id: string,
    created: number,
    version = created,
): PlaudV4RecordingItem {
    return {
        file_id: id,
        name: "Draft review",
        duration_ms: 1000,
        created_at_show_ms: created,
        version_ms: version,
    };
}

function mockPlaud(input: {
    pages: PlaudV4RecordingItem[][];
    size?: number;
    audio?: Buffer;
    nativeContent?: boolean;
    detailUnauthorized?: boolean;
    listError?: string;
    metadata?: PlaudV4FileMeta;
    beforeAudio?: () => Promise<void>;
    legacy?: boolean;
}) {
    const detailIds: string[] = [];
    const paths: string[] = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
        const url = new URL(String(request));
        paths.push(url.pathname);
        if (url.pathname === `/user-app/auth/workspace/token/${WORKSPACE}`) {
            return Response.json({
                status: 0,
                data: { workspace_token: "wt-test" },
            });
        }
        if (url.pathname === "/device/list") {
            return Response.json({
                status: 0,
                data_devices: [{ sn: "SN-TEST" }],
            });
        }
        if (input.legacy && url.pathname === "/file/simple/web") {
            const records = input.pages.flat().map((item) => ({
                ...mapPlaudV4Item(item),
                source: undefined,
                filesize: AUDIO.length,
                file_md5: AUDIO_MD5,
            }));
            return Response.json({
                status: 0,
                data_file_total: records.length,
                data_file_list: records,
            });
        }
        if (input.legacy && url.pathname.startsWith("/file/temp-url/")) {
            return Response.json({ status: 0, temp_url: AUDIO_URL });
        }
        if (url.pathname.startsWith("/file/")) {
            return Response.json({
                status: -1800907,
                msg: "Account migrated to 4.0.",
            });
        }
        if (url.pathname === "/file-app/v4/recordings/all") {
            if (input.listError)
                return Response.json({ status: -3, msg: input.listError });
            const index = Number(url.searchParams.get("cursor") ?? 0);
            return Response.json({
                status: 0,
                data: {
                    items: input.pages[index],
                    next_cursor:
                        index + 1 < input.pages.length
                            ? String(index + 1)
                            : null,
                },
            });
        }
        if (url.pathname.startsWith("/file-app/v4/files/detail/")) {
            detailIds.push(
                url.pathname.slice(url.pathname.lastIndexOf("/") + 1),
            );
            if (input.detailUnauthorized)
                return new Response(null, { status: 401 });
            return Response.json({
                status: 0,
                data: {
                    meta: input.metadata ?? {
                        serial_number: "SN-TEST",
                        timezone_iana: "Europe/Prague",
                    },
                    objects: [
                        {
                            object_type: "AUDIO_TRANSCODED",
                            object_size: input.size,
                            content_url: AUDIO_URL,
                        },
                        ...(input.nativeContent
                            ? [
                                  {
                                      object_type: "TRANSCRIPT",
                                      content_id: "native-transcript",
                                      task_status: 1,
                                  },
                                  {
                                      object_type: "SUMMARY",
                                      content_id: "native-summary",
                                      task_status: 1,
                                  },
                              ]
                            : []),
                    ],
                },
            });
        }
        if (url.pathname === "/file-app/v4/files/content/url") {
            return Response.json({
                status: 0,
                data: {
                    url_map: {
                        "native-transcript":
                            "https://audio.example.com/trans_result.json.gz",
                        "native-summary":
                            "https://audio.example.com/ai_content.md.gz",
                    },
                },
            });
        }
        if (url.href === AUDIO_URL) {
            await input.beforeAudio?.();
            return new Response(new Uint8Array(input.audio ?? AUDIO));
        }
        if (url.pathname === "/trans_result.json.gz") {
            return Response.json([
                {
                    start_time: 0,
                    end_time: 900,
                    speaker: "Speaker 1",
                    content: "Read the draft.",
                },
            ]);
        }
        if (url.pathname === "/ai_content.md.gz") {
            return new Response("Review the draft on Monday.");
        }
        throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { detailIds, paths };
}

describeWithDatabase("#428 Plaud 4.0 sync and storage cap (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const capCheck = vi.mocked(enforceStorageCap);

    beforeAll(async () => {
        if (!testDatabaseUrl) throw new Error("Test database URL is missing");
        database = await createMigratedTestDatabase(
            testDatabaseUrl,
            "plaud_v4",
        );
        mocks.ref.current = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);

    afterAll(async () => {
        mocks.ref.current = null;
        await database?.dispose();
    });

    beforeEach(async () => {
        await database.db.delete(users);
        await database.db
            .insert(users)
            .values({ id: USER, email: "owner@example.test" });
        await database.db.insert(plaudConnections).values({
            userId: USER,
            bearerToken: encrypt("ut-test"),
            apiBase: API,
            workspaceId: WORKSPACE,
        });
        mocks.storage.uploadFile.mockReset().mockResolvedValue(undefined);
        mocks.storage.deleteFile.mockReset().mockResolvedValue(undefined);
        capCheck
            .mockReset()
            .mockImplementation(async ({ userId, additionalBytes }) => {
                const [row] = await database.db
                    .select({ bytes: sum(recordings.filesize) })
                    .from(recordings)
                    .where(eq(recordings.userId, userId));
                const currentBytes = Number(row?.bytes ?? 0);
                return {
                    allowed: currentBytes + additionalBytes <= CAP,
                    currentBytes,
                    limitBytes: CAP,
                };
            });
    });

    afterEach(() => vi.unstubAllGlobals());

    async function seedLegacy(
        ids: string[],
        overrides: Partial<TestRecordingInsert> = {},
    ) {
        await insertRecordings(
            database.db,
            ids.map((id) => ({
                id: `local-${id}`,
                userId: USER,
                filename: encryptText("Original draft"),
                plaudFileId: id,
                startTime: new Date(0),
                endTime: new Date(1000),
                duration: 1000,
                deviceSn: "SN-TEST",
                filesize: 0,
                fileMd5: AUDIO_MD5,
                storageType: "local",
                storagePath: `users/test-owner/${id}.mp3`,
                downloadedAt: new Date(1000),
                plaudVersion: "1",
                ...overrides,
            })),
        );
    }

    it("matches migrated rows, imports new audio and native content, and skips unchanged rows on the next run", async () => {
        await seedLegacy(["legacy"]);
        await database.db
            .insert(userSettings)
            .values({ userId: USER, importPlaudContent: true });
        const { detailIds } = mockPlaud({
            pages: [[v4Item("f_new", 2), v4Item("of_legacy", 1)]],
            nativeContent: true,
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 1,
            updatedRecordings: 0,
            errors: [],
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 0,
            updatedRecordings: 0,
            errors: [],
        });
        expect(detailIds).toEqual(["f_new", "f_new"]);
        expect(mocks.storage.uploadFile).toHaveBeenCalledOnce();

        const rows = await database.db
            .select()
            .from(recordings)
            .orderBy(recordings.plaudFileId);
        expect(rows.map((row) => row.plaudFileId)).toEqual(["f_new", "legacy"]);
        expect(rows[0]).toMatchObject({
            fileMd5: AUDIO_MD5,
            filesize: AUDIO.length,
            deviceSn: "SN-TEST",
        });
        expect(rows[1].id).toBe("local-legacy");
        const [transcript] = await database.db.select().from(transcriptions);
        const [summary] = await database.db.select().from(aiEnhancements);
        expect(transcript).toMatchObject({
            source: "plaud",
            audioMd5: AUDIO_MD5,
        });
        expect(decryptText(transcript?.text)).toContain("Read the draft.");
        expect(decryptText(summary?.summary)).toBe(
            "Review the draft on Monday.",
        );
        expect(await database.db.select().from(asyncJobs)).not.toHaveLength(0);
    });

    it("updates an edited legacy recording older than two unchanged pages", async () => {
        const ids = Array.from({ length: 100 }, (_, i) => `legacy-${i + 1}`);
        await seedLegacy([...ids, "old"]);
        const unchanged = ids.map((id, index) =>
            v4Item(`of_${id}`, 200 - index, 1),
        );
        const { detailIds } = mockPlaud({
            pages: [
                unchanged.slice(0, 50),
                unchanged.slice(50),
                [v4Item("of_old", 1, 201)],
            ],
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 0,
            updatedRecordings: 1,
            errors: [],
        });
        expect(detailIds).toEqual(["of_old"]);
        expect(mocks.storage.uploadFile).toHaveBeenCalledOnce();
        const [updated] = await database.db
            .select()
            .from(recordings)
            .where(eq(recordings.id, "local-old"));
        expect(updated).toMatchObject({
            plaudVersion: "201",
            fileMd5: AUDIO_MD5,
        });
    });

    it("checks an unknown download's byte length before uploading", async () => {
        const { paths } = mockPlaud({
            pages: [[v4Item("f_large", 1)]],
            audio: Buffer.alloc(CAP + 1),
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 0,
        });
        expect(paths).toContain("/recording.mp3");
        expect(
            capCheck.mock.calls.map(([request]) => request.additionalBytes),
        ).toEqual([CAP + 1]);
        expect(mocks.storage.uploadFile).not.toHaveBeenCalled();
    });

    it("checks the unreserved bytes when the v4 download is larger than advertised", async () => {
        mockPlaud({
            pages: [[v4Item("f_large", 1)]],
            size: 10,
            audio: Buffer.alloc(CAP + 1),
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 0,
        });
        expect(
            capCheck.mock.calls.map(([request]) => request.additionalBytes),
        ).toEqual([10, CAP + 1]);
        expect(mocks.storage.uploadFile).not.toHaveBeenCalled();
    });

    it("persistently accounts for the actual v4 download size", async () => {
        mockPlaud({ pages: [[v4Item("f_new", 1)]], size: 90 });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 1,
        });
        const [recording] = await database.db.select().from(recordings);
        expect(recording.filesize).toBe(AUDIO.length);
        expect(capCheck).toHaveBeenCalledExactlyOnceWith({
            userId: USER,
            additionalBytes: 90,
        });
    });

    it("checks a known oversize recording before downloading", async () => {
        const { paths } = mockPlaud({
            pages: [[v4Item("f_large", 1)]],
            size: CAP + 1,
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 0,
        });
        expect(capCheck).toHaveBeenCalledExactlyOnceWith({
            userId: USER,
            additionalBytes: CAP + 1,
        });
        expect(paths).not.toContain("/recording.mp3");
    });

    it("includes pending bytes when concurrent downloads are admitted", async () => {
        mockPlaud({ pages: [[v4Item("f_one", 2), v4Item("f_two", 1)]] });
        const upload = Promise.withResolvers<void>();
        mocks.storage.uploadFile.mockReturnValue(upload.promise);
        const sync = syncRecordingsForUser(USER);
        try {
            await vi.waitFor(() => expect(capCheck).toHaveBeenCalledTimes(2));
        } finally {
            upload.resolve();
        }
        const result = await sync;
        expect(result.newRecordings).toBe(1);
        expect(result.errors).toEqual([
            expect.stringContaining("Storage limit reached"),
        ]);
        expect(
            capCheck.mock.calls.map(([request]) => request.additionalBytes),
        ).toEqual([60, 120]);
        expect(mocks.storage.uploadFile).toHaveBeenCalledOnce();
    });

    it("releases reservations after persistence and after a rejected cap query", async () => {
        const small = AUDIO.subarray(0, 10);
        mockPlaud({
            pages: [Array.from({ length: 6 }, (_, i) => v4Item(`f_${i}`, i))],
            size: small.length,
            audio: small,
        });
        capCheck.mockRejectedValueOnce(
            new Error("Temporary quota lookup failure"),
        );
        const result = await syncRecordingsForUser(USER);
        expect(result.newRecordings).toBe(5);
        expect(result.errors).toEqual([
            "Failed to sync Draft review: An unexpected error occurred",
        ]);
        expect(capCheck.mock.calls[0][0].additionalBytes).toBe(small.length);
        expect(capCheck.mock.calls[1][0].additionalBytes).toBe(small.length);
        expect(capCheck.mock.calls.at(-1)?.[0].additionalBytes).toBe(
            small.length,
        );
    });

    it("returns a reconnect result when v4 detail rejects the token", async () => {
        mockPlaud({ pages: [[v4Item("f_new", 1)]], detailUnauthorized: true });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 0,
            needsReconnect: true,
            errorCode: ErrorCode.PLAUD_INVALID_TOKEN,
        });
        const [connection] = await database.db.select().from(plaudConnections);
        expect(connection.invalidatedAt).toBeInstanceOf(Date);
        expect(connection.lastSync).toBeNull();
        expect(mocks.storage.uploadFile).not.toHaveBeenCalled();
    });

    it("reports v4 counts in the dev diagnostics route", async () => {
        const { paths } = mockPlaud({
            pages: [[v4Item("f_new", 2)], [v4Item("of_legacy", 1)]],
        });
        const response = await getPlaudInfo(
            new Request("https://app.example.test/api/dev/plaud/info"),
        );
        expect(await response.json()).toMatchObject({
            reachable: true,
            stats: {
                activeRecordingCount: 2,
                trashedRecordingCount: null,
                deviceCount: 1,
            },
        });
        expect(
            paths.filter((path) => path === "/file/simple/web"),
        ).toHaveLength(1);
    });

    it("returns whole-run failures in the manual sync response", async () => {
        mockPlaud({
            pages: [[]],
            listError: "Unable to list private recording title",
        });
        const response = await manualSync(
            new Request("https://app.example.test/api/plaud/sync", {
                method: "POST",
            }),
        );
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body).toMatchObject({
            success: false,
            newRecordings: 0,
            updatedRecordings: 0,
            error: "Failed to sync with Plaud device",
            code: ErrorCode.PLAUD_API_ERROR,
            needsReconnect: false,
        });
        expect(JSON.stringify(body)).not.toContain("private recording title");
        const [connection] = await database.db.select().from(plaudConnections);
        expect(connection.lastSync).toBeNull();
    });

    it.each([
        { metadata: {}, deviceSn: "SN-OLD", timezone: 2, zonemins: 30 },
        {
            metadata: { timezone_iana: "Not/AZone" },
            deviceSn: "SN-OLD",
            timezone: 2,
            zonemins: 30,
        },
        {
            metadata: { timezone_iana: "UTC", serial_number: "SN-NEW" },
            deviceSn: "SN-NEW",
            timezone: 0,
            zonemins: 0,
        },
    ])("preserves legacy metadata unless v4 supplies it ($metadata)", async ({
        metadata,
        ...expected
    }) => {
        await seedLegacy(["legacy"], {
            deviceSn: "SN-OLD",
            timezone: 2,
            zonemins: 30,
            scene: 7,
            storagePath: OLD_OGG,
            storageFilename: "Original.ogg",
            fileMd5: "previous-checksum",
        });
        mockPlaud({ pages: [[v4Item("of_legacy", 1, 2)]], metadata });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            updatedRecordings: 1,
            errors: [],
        });
        const [row] = await database.db.select().from(recordings);
        expect(row).toMatchObject({
            ...expected,
            scene: 7,
            storagePath: OLD_OGG,
            storageFilename: "Original.ogg",
            fileMd5: AUDIO_MD5,
            filesize: AUDIO.length,
        });
        expect(mocks.storage.uploadFile).toHaveBeenCalledExactlyOnceWith(
            OLD_OGG,
            AUDIO,
            "audio/mpeg",
        );
        expect(mocks.storage.deleteFile).not.toHaveBeenCalled();
    });

    it("uses a separate key when another recording still references the existing audio", async () => {
        await seedLegacy(["legacy", "other"], { storagePath: OLD_OGG });
        mockPlaud({ pages: [[v4Item("of_legacy", 1, 2)]] });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            updatedRecordings: 1,
            errors: [],
        });
        expect(mocks.storage.deleteFile).not.toHaveBeenCalled();
        const rows = await database.db
            .select()
            .from(recordings)
            .orderBy(recordings.id);
        const newPath = `${USER}/.pending/local-legacy.mp3`;
        expect(rows.map((row) => row.storagePath)).toEqual([newPath, OLD_OGG]);
        expect(mocks.storage.uploadFile).toHaveBeenCalledExactlyOnceWith(
            newPath,
            AUDIO,
            "audio/mpeg",
        );
    });

    it("keeps the published staging key when a concurrent sync hits the version guard", async () => {
        await seedLegacy(["legacy", "other"], { storagePath: OLD_OGG });
        mockPlaud({ pages: [[v4Item("of_legacy", 1, 2)]] });

        vi.resetModules();
        const { syncRecordingsForUser: syncOnAnotherWorker } =
            await vi.importActual<typeof SyncModule>(
                "@/lib/sync/sync-recordings",
            );
        const firstUpload = Promise.withResolvers<void>();
        const secondUpload = Promise.withResolvers<void>();
        const objects = new Map<string, Buffer>([
            [OLD_OGG, Buffer.from("shared audio")],
        ]);
        mocks.storage.uploadFile.mockImplementation(
            (key: string, data: Buffer) => {
                objects.set(key, data);
                return mocks.storage.uploadFile.mock.calls.length === 1
                    ? firstUpload.promise
                    : secondUpload.promise;
            },
        );
        mocks.storage.deleteFile.mockImplementation(async (key: string) => {
            objects.delete(key);
        });

        const first = syncRecordingsForUser(USER);
        let second: ReturnType<typeof syncRecordingsForUser> | undefined;
        try {
            await vi.waitFor(() =>
                expect(mocks.storage.uploadFile).toHaveBeenCalledTimes(1),
            );
            second = syncOnAnotherWorker(USER);
            await vi.waitFor(() =>
                expect(mocks.storage.uploadFile).toHaveBeenCalledTimes(2),
            );
            firstUpload.resolve();
            expect(await first).toMatchObject({
                updatedRecordings: 1,
                errors: [],
            });
            secondUpload.resolve();
            expect(await second).toMatchObject({
                updatedRecordings: 0,
                errors: [],
            });
        } finally {
            firstUpload.resolve();
            secondUpload.resolve();
            await Promise.allSettled([first, second]);
        }

        const [updated, other] = await database.db
            .select()
            .from(recordings)
            .orderBy(recordings.id);
        expect(updated.plaudVersion).toBe("2");
        expect(updated.storagePath).toBe(`${USER}/.pending/local-legacy.mp3`);
        expect(other.storagePath).toBe(OLD_OGG);
        expect(objects.get(updated.storagePath)).toEqual(AUDIO);
    });

    it.each([
        {
            label: "without timing or name",
            metadata: {},
            duration: 2000,
            end: 7000,
        },
        {
            label: "with a zero duration and a missing start",
            metadata: { duration: 0 },
            duration: 0,
            end: 5000,
        },
    ])("preserves omitted v4 metadata on an existing recording ($label)", async ({
        metadata,
        duration,
        end,
    }) => {
        const occurredAt = new Date(5000);
        await seedLegacy(["legacy"], {
            startTime: occurredAt,
            endTime: new Date(7000),
            duration: 2000,
        });
        mockPlaud({
            pages: [[{ file_id: "of_legacy", version_ms: 2 }]],
            metadata,
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            updatedRecordings: 1,
            errors: [],
        });
        const [recording] = await database.db.select().from(recordings);
        const [item] = await database.db.select().from(chatterItems);
        expect(recording).toMatchObject({
            duration,
            endTime: new Date(end),
        });
        expect(item.occurredAt).toEqual(occurredAt);
        expect(decryptText(item.title)).toBe("Original draft");
    });

    it("uses the existing defaults for a new v4 recording with omitted metadata", async () => {
        mockPlaud({
            pages: [[{ file_id: "f_new", version_ms: 1 }]],
            metadata: {},
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            newRecordings: 1,
            errors: [],
        });
        const [recording] = await database.db.select().from(recordings);
        const [item] = await database.db.select().from(chatterItems);
        expect(recording).toMatchObject({
            duration: 0,
            endTime: new Date(0),
        });
        expect(item.occurredAt).toEqual(new Date(0));
        expect(decryptText(item.title)).toBe("");
    });

    it.each([
        false,
        true,
    ])("does not apply a numerically older Plaud version (legacy=%s)", async (legacy) => {
        await seedLegacy(["legacy"], { plaudVersion: "10" });
        const { paths } = mockPlaud({
            pages: [[v4Item(legacy ? "legacy" : "of_legacy", 1, 9)]],
            legacy,
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            updatedRecordings: 0,
            errors: [],
        });
        const [row] = await database.db.select().from(recordings);
        expect(row.plaudVersion).toBe("10");
        expect(paths).not.toContain("/recording.mp3");
        expect(mocks.storage.uploadFile).not.toHaveBeenCalled();
    });

    it.each([
        false,
        true,
    ])("keeps the newer version committed during the download (legacy=%s)", async (legacy) => {
        await seedLegacy(["legacy"]);
        mockPlaud({
            legacy,
            pages: [[v4Item(legacy ? "legacy" : "of_legacy", 1, 9)]],
            beforeAudio: async () => {
                await database.db
                    .update(recordings)
                    .set({ plaudVersion: "10" })
                    .where(eq(recordings.id, "local-legacy"));
            },
        });
        expect(await syncRecordingsForUser(USER)).toMatchObject({
            updatedRecordings: 0,
            errors: [],
        });
        const [row] = await database.db.select().from(recordings);
        expect(row.plaudVersion).toBe("10");
        expect(mocks.storage.uploadFile).not.toHaveBeenCalled();
    });

    it("keeps per-recording errors in a successful manual response", async () => {
        mockPlaud({ pages: [[v4Item("f_new", 1)]] });
        mocks.storage.uploadFile.mockRejectedValueOnce(
            new Error("One upload failed"),
        );
        const response = await manualSync(
            new Request("https://app.example.test/api/plaud/sync", {
                method: "POST",
            }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            success: true,
            errors: [
                "Failed to sync Draft review: An unexpected error occurred",
            ],
        });
    });

    it("keeps the remote original active after both erase and retention fail", async () => {
        await seedLegacy(["legacy"]);
        const { paths } = mockPlaud({ pages: [[]] });
        const response = await eraseRecording(
            new Request(
                "https://app.example.test/api/recordings/local-legacy/erase",
                {
                    method: "POST",
                    body: JSON.stringify({ scope: "plaud" }),
                },
            ),
            { params: Promise.resolve({ id: "local-legacy" }) },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            code: ErrorCode.PLAUD_API_ERROR,
            error: "Moving to Plaud Trash is not supported for Plaud 4.0 accounts yet.",
        });

        const [row] = await database.db.select().from(recordings);
        expect(row.isTrash).toBe(false);
        const outcome = await reapRecording(
            await createUserStorageProvider(USER),
            {
                userId: USER,
                remoteOriginalDays: 1,
                audioDays: null,
                transcriptDays: null,
                summaryDays: null,
            },
            {
                ...row,
                startTime: new Date(0),
                transcriptReapedAt: null,
                summaryReapedAt: null,
            },
            new Date("2025-01-02T00:00:00Z"),
        );
        expect(outcome.reaped).toEqual([]);
        expect(outcome.failed.remoteOriginal).toMatchObject({
            code: ErrorCode.PLAUD_API_ERROR,
        });
        const [after] = await database.db.select().from(recordings);
        expect(after).toMatchObject({
            isTrash: false,
            remoteRetentionClaimedAt: null,
        });
        expect(paths.filter((path) => path.startsWith("/file/"))).toEqual([
            "/file/legacy",
            "/file/legacy",
        ]);
    });
});
