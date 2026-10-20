import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { recordingFolders, users } from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { gate, holderAccess, state, dbRef, dbProxy, testEnv } = vi.hoisted(
    () => {
        const dbRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        return {
            dbRef,
            dbProxy: new Proxy(
                {},
                {
                    get: (_, property) => {
                        if (!dbRef.current)
                            throw new Error("test database not ready");
                        const value = dbRef.current[property];
                        return typeof value === "function"
                            ? value.bind(dbRef.current)
                            : value;
                    },
                },
            ),
            gate: vi.fn(),
            holderAccess: vi.fn(),
            state: { idp: false },
            testEnv: {
                IS_HOSTED: false,
                SELF_HOST_MODE: "shared",
                ORG_ACCOUNT_EMAIL: "organization@recorder.test",
                ORG_ACCOUNT_PASSWORD: "test-password",
                BETTER_AUTH_SECRET: "recorder-folder-test-secret",
                ENCRYPTION_KEY:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                DATABASE_URL: "postgres://unused",
            },
        };
    },
);
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: testEnv }));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
}));
vi.mock("@/lib/authz/access-state", () => ({ holderAccess }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: gate,
}));

import { GET } from "@/app/api/v1/recorder/folders/route";
import { assertCategorizableFolders } from "@/lib/folders/folders";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const folderUrl = "https://recorder.test/api/v1/recorder/folders";

function request(params?: Record<string, string>) {
    return new Request(
        `${folderUrl}${params ? `?${new URLSearchParams(params)}` : ""}`,
    );
}

describeWithDatabase("GET /api/v1/recorder/folders", () => {
    let database: TestPostgresDatabase;
    async function addFolder(
        id: string,
        name: string,
        parentId = "private-root",
        userId = "owner",
    ) {
        await database.db.insert(recordingFolders).values({
            id,
            name: encryptText(name),
            nameHash: lookupHash(name),
            parentId,
            userId,
            kind: "custom",
        });
    }
    async function ids(params?: Record<string, string>) {
        const response = await GET(request(params));
        expect(response.status).toBe(200);
        const body: { data: { id: string }[] } = await response.json();
        return body.data.map((folder) => folder.id);
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "recorder_folders",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await database.db.insert(users).values([
            { id: "owner", email: "owner@recorder.test" },
            { id: "other", email: "other@recorder.test" },
            {
                id: "organization",
                role: "org",
                email: "organization@recorder.test",
            },
        ]);
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        vi.clearAllMocks();
        state.idp = false;
        testEnv.IS_HOSTED = false;
        testEnv.ORG_ACCOUNT_PASSWORD = "test-password";
        gate.mockResolvedValue({
            authn: {
                user: { id: "owner" },
                via: "api-key",
                apiKeyId: "recorder-key",
                scopes: ["recordings:write"],
            },
        });
        holderAccess.mockResolvedValue({
            ok: true,
            capabilities: new Set(["use"]),
        });
        await database.db.delete(recordingFolders);
        await database.db.insert(recordingFolders).values([
            {
                id: "private-root",
                userId: "owner",
                name: encryptText("Private"),
                nameHash: lookupHash("Private"),
                kind: "private",
            },
            {
                id: "other-root",
                userId: "other",
                name: encryptText("Private"),
                nameHash: lookupHash("Private"),
                kind: "private",
            },
            {
                id: "org-root",
                userId: "organization",
                name: encryptText("Organization"),
                nameHash: lookupHash("Organization"),
                kind: "public",
            },
        ]);
        await addFolder("personal", "Project");
        await addFolder("org", "Sales", "org-root", "organization");
        await addFolder(
            "other-private",
            "Secret Project",
            "other-root",
            "other",
        );
    });

    it("keeps the legacy full list, excludes roots and other users, and uses the recorder gate", async () => {
        const req = request();
        const response = await GET(req);
        expect(gate).toHaveBeenCalledExactlyOnceWith(req);
        await expect(response.json()).resolves.toEqual({
            data: [
                {
                    id: "personal",
                    name: "Project",
                    path: "Private / Project",
                    scope: "personal",
                },
                {
                    id: "org",
                    name: "Sales",
                    path: "Organization / Sales",
                    scope: "org",
                },
            ],
        });
    });
    it("matches every word across a path, ignoring accents, case and query whitespace", async () => {
        await addFolder("clients", "Klienti");
        await addFolder("accented", "Žluťoučký projekt", "clients");
        expect(await ids({ q: "  KLIENTI   zlutoucky  " })).toEqual([
            "accented",
        ]);
        expect(await ids({ q: "ŽLUŤOUČKÝ" })).toEqual(["accented"]);
        expect(await ids({ q: "projekt absent" })).toEqual([]);
    });
    it("ranks complete name matches before path-only matches, then path length and path", async () => {
        await addFolder("branch", "Amber");
        await addFolder("path-only", "X", "branch");
        await addFolder("long-parent", "Long branch");
        await addFolder("name-first", "Amber", "long-parent");
        await addFolder("tie-b", "Amber B");
        await addFolder("tie-a", "Amber A");
        expect(await ids({ q: "amber" })).toEqual([
            "branch",
            "tie-a",
            "tie-b",
            "name-first",
            "path-only",
        ]);
    });
    it("limits only searches to 20, keeping server ranking", async () => {
        for (let index = 24; index >= 0; index--)
            await addFolder(
                `match-${index}`,
                `Match ${String(index).padStart(2, "0")}`,
            );
        expect(await ids({ q: "match" })).toEqual(
            Array.from({ length: 20 }, (_, index) => `match-${index}`),
        );
        expect(await ids()).toHaveLength(27);
    });
    it.each([
        "",
        " ",
        " a ",
    ])("rejects short q=%j with a clear 400", async (q) => {
        const response = await GET(request({ q }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: "Folder search needs at least 2 characters",
        });
    });
    it("treats search punctuation literally", async () => {
        await addFolder("literal", "Plan %_ overview");
        expect(await ids({ q: "%_" })).toEqual(["literal"]);
    });
    it("returns the remembered folder's current full path", async () => {
        expect(await ids({ id: "personal" })).toEqual(["personal"]);
        expect(await ids({ id: "org" })).toEqual(["org"]);
    });
    it.each([
        "missing",
        "",
        "private-root",
        "org-root",
        "other-private",
    ])("returns 404 for unavailable id=%s", async (id) => {
        expect((await GET(request({ id }))).status).toBe(404);
    });
    it("does not disclose another user's private folders in searches", async () => {
        expect(await ids({ q: "secret" })).toEqual([]);
    });
    it("rejects ambiguous q and id", async () => {
        expect(
            (await GET(request({ q: "project", id: "personal" }))).status,
        ).toBe(400);
    });
    it("hides read-only Organization folders from every response and rejects their uploads", async () => {
        testEnv.ORG_ACCOUNT_PASSWORD = "";
        expect(await ids()).toEqual(["personal"]);
        expect(await ids({ q: "sales" })).toEqual([]);
        expect((await GET(request({ id: "org" }))).status).toBe(404);
        await expect(
            assertCategorizableFolders("owner", ["org"]),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            assertCategorizableFolders("owner", ["personal"]),
        ).resolves.toHaveLength(1);
    });
    it.each([
        false,
        true,
    ])("hides Organization folders when IdP access is missing (ok=%s)", async (ok) => {
        state.idp = true;
        holderAccess.mockResolvedValue({
            ok,
            capabilities: new Set(["org.curate"]),
            reason: "not-granted",
        });
        expect(await ids()).toEqual(["personal"]);
        expect(await ids({ q: "sales" })).toEqual([]);
        expect((await GET(request({ id: "org" }))).status).toBe(404);
        await expect(
            assertCategorizableFolders("owner", ["org"]),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
    it("checks the IdP holder once per listing and allows use without curate", async () => {
        state.idp = true;
        await addFolder("org-two", "Support", "org-root", "organization");
        expect(await ids({ q: "organization" })).toEqual(["org", "org-two"]);
        expect(holderAccess).toHaveBeenCalledExactlyOnceWith("owner");
        await expect(
            assertCategorizableFolders("owner", ["org", "org-two"]),
        ).resolves.toHaveLength(2);
    });
    it("keeps personal folders usable in hosted mode", async () => {
        testEnv.IS_HOSTED = true;
        expect(await ids()).toEqual(["personal"]);
    });
    it("keeps root rejection in the shared upload check", async () => {
        await expect(
            assertCategorizableFolders("owner", ["private-root"]),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            assertCategorizableFolders("owner", ["other-private"]),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it.each([
        401, 403, 429,
    ])("preserves the shared gate's %s response before querying folders", async (status) => {
        if (status === 429)
            gate.mockResolvedValue({
                response: new Response("limited", { status }),
            });
        else
            gate.mockRejectedValue(
                new AppError(
                    status === 401
                        ? ErrorCode.UNAUTHORIZED
                        : ErrorCode.FORBIDDEN,
                    "Recorder key rejected",
                    status,
                ),
            );
        expect((await GET(request({ q: "project" }))).status).toBe(status);
        expect(holderAccess).not.toHaveBeenCalled();
    });
});
