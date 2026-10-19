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
import { POST as pair } from "@/app/api/settings/recorder/pair/route";
import { GET as status } from "@/app/api/settings/recorder/status/route";
import {
    apiKeys,
    recordingCaptureKeys,
    recordingSessions,
    users,
} from "@/db/schema";
import { captureServerException } from "@/lib/posthog-server";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import {
    createRecordingSession,
    replaceRecordingSession,
} from "@/lib/recording-sessions/store";
import type { StorageProvider } from "@/lib/storage/types";
import { saveUploadedAudioFile } from "@/lib/uploads/save-uploaded-audio-file";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, dbProxy, mint, reserve } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        mint: vi.fn(),
        reserve: vi.fn(),
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property) => {
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
vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, SELF_HOST_MODE: "shared" },
}));
vi.mock("@/lib/sso/config", () => ({ isSsoEnabled: () => false }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "org" } }),
}));
vi.mock("@/lib/auth-request", () => ({
    authenticateRequest: async () => ({
        via: "api-key",
        apiKeyId: "old-org-key",
        user: { id: "org" },
    }),
    requireApiScope: vi.fn(),
    createApiKey: mint,
    getApiKeyPrefix: vi.fn(),
    hashApiKey: vi.fn(),
}));
vi.mock("@/lib/entitlements", () => ({ isHostedLockedOut: async () => false }));
vi.mock("@/lib/v1/rate-limit", () => ({
    enforceV1IpRateLimit: async () => null,
    enforceV1AuthenticatedRateLimit: async () => null,
}));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimitBucket: reserve }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/encryption", () => ({
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
}));

const url = getTestDatabaseUrl();
describe.skipIf(!url)(
    "recorder refuses Organization account ownership (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase;
        const storage: StorageProvider = {
            uploadFile: vi.fn(),
            uploadStream: vi.fn(),
            downloadFile: vi.fn(),
            downloadStream: vi.fn(),
            exists: vi.fn(),
            getSignedUrl: vi.fn(),
            deleteFile: vi.fn(),
            testConnection: vi.fn(),
        };
        beforeEach(() => {
            vi.clearAllMocks();
            vi.spyOn(console, "warn").mockImplementation(() => {});
        });
        afterEach(() => vi.restoreAllMocks());
        function expectRefusal(surface: string, sessionId?: string) {
            const context = {
                userId: "org",
                surface,
                ...(sessionId ? { sessionId } : {}),
            };
            expect(console.warn).toHaveBeenCalledExactlyOnceWith(
                "[recorder] Organization account refused",
                context,
            );
            expect(captureServerException).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ code: "FORBIDDEN", statusCode: 403 }),
                {
                    source: "recorder",
                    distinctId: "org",
                    reason: "organization_account_refused",
                    ...context,
                },
            );
        }
        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "recorder_org_refused",
            );
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await database.db.insert(users).values([
                { id: "org", email: "org@example.test", role: "org" },
                { id: "member", email: "member@example.test" },
            ]);
            await database.db.insert(apiKeys).values({
                id: "member-key",
                userId: "member",
                name: "Recorder",
                keyHash: "hash",
                keyPrefix: "prefix",
                scopes: ["recordings:write"],
                source: "recorder",
            });
        }, 120_000);
        afterAll(async () => {
            ref.current = null;
            await database?.dispose();
        }, 30_000);
        it.each([
            ["pair", pair],
            ["status", status],
        ] as const)("refuses %s before key creation or status reads", async (_name, handler) => {
            const response = await handler(
                new Request("https://example.test/api/settings/recorder", {
                    method: _name === "pair" ? "POST" : "GET",
                }),
            );
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
            expectRefusal(`settings/recorder/${_name}`);
            expect(mint).not.toHaveBeenCalled();
            expect(reserve).not.toHaveBeenCalled();
        });
        it.each([
            "",
            "/old-session/chunks/0",
            "/old-session/complete",
            "/old-session/recover",
        ])("refuses recording-session route %s even with an old Organization API key", async (suffix) => {
            await expect(
                gateRecordingSessionRequest(
                    new Request(
                        `https://example.test/api/v1/recording-sessions${suffix}?token=not-logged`,
                    ),
                ),
            ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
            expectRefusal(
                `GET /api/v1/recording-sessions${suffix}`,
                suffix ? "old-session" : undefined,
            );
        });
        it("refuses direct store creation and replacement without leaving capture or session rows", async () => {
            await expect(
                createRecordingSession({
                    userId: "org",
                    apiKeyId: "old-org-key",
                    clientRecordingId: crypto.randomUUID(),
                    mimeType: "audio/webm",
                    metadata: { channelLayout: ["microphone"] },
                    startedAt: new Date(),
                    noticeAcknowledgedAt: null,
                    folderId: null,
                }),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
            expectRefusal("createRecordingSession");
            vi.clearAllMocks();
            await expect(
                replaceRecordingSession({
                    userId: "org",
                    apiKeyId: "old-org-key",
                    sessionId: "old-session",
                }),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
            expectRefusal("replaceRecordingSession", "old-session");
            expect(
                await database.db.select().from(recordingCaptureKeys),
            ).toEqual([]);
            expect(await database.db.select().from(recordingSessions)).toEqual(
                [],
            );
        });
        it("refuses final audio saving before reading a file or writing storage", async () => {
            await expect(
                saveUploadedAudioFile({
                    userId: "org",
                    sessionId: "old-session",
                    fileId: "recording",
                    basename: "Meeting",
                    extension: ".webm",
                    filePath: "/nonexistent-recording.webm",
                    storage,
                    recordedAt: new Date(),
                }),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
            expectRefusal("saveUploadedAudioFile", "old-session");
            expect(storage.uploadStream).not.toHaveBeenCalled();
        });
        it("still lets a regular member start a personal recording session", async () => {
            const result = await createRecordingSession({
                userId: "member",
                apiKeyId: "member-key",
                clientRecordingId: crypto.randomUUID(),
                mimeType: "audio/webm",
                metadata: { channelLayout: ["microphone"] },
                startedAt: new Date(),
                noticeAcknowledgedAt: null,
                folderId: null,
            });
            expect(result.session.userId).toBe("member");
            expect(result.session.status).toBe("open");
            expect(console.warn).not.toHaveBeenCalled();
            expect(captureServerException).not.toHaveBeenCalled();
        });
    },
);
