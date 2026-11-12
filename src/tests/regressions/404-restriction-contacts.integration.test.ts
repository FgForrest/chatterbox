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
import { GET } from "@/app/api/folders/[id]/restriction-contacts/route";
import {
    accounts,
    recordingFolders,
    restrictedFolderMembers,
    userAccessStates,
    users,
} from "@/db/schema";
import type { Capability } from "@/lib/authz/catalog";
import { encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, state, mockEnv, verify } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        verify: vi.fn(),
        dbRef: ref,
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
        state: { userId: "member", signedIn: true },
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            AUTHZ_MODE: "local",
            ORG_ACCOUNT_EMAIL: "org@example.com",
            ORG_ACCOUNT_PASSWORD: "test-password",
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            DATABASE_URL: "postgres://unused",
            BETTER_AUTH_SECRET: "restriction-contacts-test-secret",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
    };
});
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => mockEnv.AUTHZ_MODE === "idp",
    getAccessVerifier: () => ({ verify }),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => {
        if (!state.signedIn)
            throw new AppError(
                ErrorCode.UNAUTHORIZED,
                ErrorCode.UNAUTHORIZED,
                401,
            );
        return { user: { id: state.userId } };
    },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const orgContact = {
    id: "org",
    name: "Organization",
    email: "org@example.com",
};
const ada = { id: "ada", name: "Ada Fern", email: "ada@example.com" };
const bela = { id: "bela", name: "Bela Pine", email: "bela@example.com" };

describeWithDatabase("restriction contacts endpoint (#404)", () => {
    let database: TestPostgresDatabase;
    function db() {
        return database.db;
    }
    async function read(id = "open") {
        return GET(
            new Request(
                `https://app.example.com/api/folders/${id}/restriction-contacts`,
            ),
            { params: Promise.resolve({ id }) },
        );
    }
    async function grant(
        userId: string,
        capabilities: Capability[] = ["use", "org.curate"],
        status: "active" | "disabled" | "missing" = "active",
        verifiedAt = new Date(),
    ) {
        await db().insert(userAccessStates).values({
            userId,
            issuer: "https://id.example.com",
            subject: userId,
            capabilities,
            status,
            verifiedAt,
            source: "login",
        });
    }
    async function setCreator(userId: string | null) {
        await db()
            .update(recordingFolders)
            .set({ createdByUserId: userId })
            .where(eq(recordingFolders.id, "open"));
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "restriction_contacts_404",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        verify.mockReset().mockResolvedValue({
            status: "active",
            capabilities: new Set(["use", "org.curate"]),
        });
        state.userId = "member";
        state.signedIn = true;
        mockEnv.AUTHZ_MODE = "local";
        mockEnv.SELF_HOST_MODE = "shared";
        await db().delete(recordingFolders);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { ...orgContact, role: "org" },
                { id: "member", name: "Cora Elm", email: "member@example.com" },
                ada,
                bela,
                {
                    id: "suspended",
                    name: "Dara Ash",
                    email: "suspended@example.com",
                    suspendedAt: new Date(),
                },
                {
                    id: "unverified",
                    name: "Ena Birch",
                    email: "unverified@example.com",
                },
                {
                    id: "disabled",
                    name: "Fara Oak",
                    email: "disabled@example.com",
                },
                { id: "stale", name: "Gita Reed", email: "stale@example.com" },
                {
                    id: "without-use",
                    name: "Hana Vale",
                    email: "without-use@example.com",
                },
            ]);
        for (const input of [
            { id: "root", userId: "org", kind: "public" as const },
            { id: "open", userId: "org", kind: "custom" as const },
            {
                id: "locked",
                userId: "org",
                kind: "custom" as const,
                restrictedAt: new Date(),
            },
            { id: "own", userId: "member", kind: "custom" as const },
            { id: "other", userId: "ada", kind: "custom" as const },
        ])
            await db()
                .insert(recordingFolders)
                .values({
                    ...input,
                    name: encryptText(input.id),
                    nameHash: lookupHash(input.id),
                });
    });

    it("requires a session", async () => {
        state.signedIn = false;
        expect((await read()).status).toBe(401);
    });
    it.each([
        "missing",
        "locked",
        "own",
        "other",
        "root",
    ])("conceals unreadable and non-custom Organization folders: %s", async (id) => {
        const response = await read(id);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            code: "NOT_FOUND",
            error: "NOT_FOUND",
        });
    });
    it("conceals the Organization in local-only and hosted deployments", async () => {
        mockEnv.SELF_HOST_MODE = "local";
        expect((await read()).status).toBe(404);
        mockEnv.SELF_HOST_MODE = "shared";
        mockEnv.IS_HOSTED = true;
        try {
            expect((await read()).status).toBe(404);
        } finally {
            mockEnv.IS_HOSTED = false;
        }
    });
    it("allows a restricted folder's audience to read its contacts", async () => {
        await db().insert(restrictedFolderMembers).values({
            folderId: "locked",
            userId: "member",
            addedByUserId: "org",
        });
        const response = await read("locked");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            curators: [orgContact],
            creator: null,
        });
    });
    it("returns only the local Organization account as curator and an unknown creator as null", async () => {
        expect(await (await read()).json()).toEqual({
            curators: [orgContact],
            creator: null,
        });
    });
    it("returns a separate creator who is not a curator", async () => {
        await setCreator("bela");
        expect(await (await read()).json()).toEqual({
            curators: [orgContact],
            creator: bela,
        });
    });
    it("lists a local creator who is also the curator only once", async () => {
        await setCreator("org");
        expect(await (await read()).json()).toEqual({
            curators: [orgContact],
            creator: null,
        });
    });
    it("uses verified idp curators, sorted by name, excluding suspended, deleted, disabled, unverified and stale holders", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await grant("bela");
        await grant("ada");
        await grant("suspended");
        await grant("disabled", ["use", "org.curate"], "disabled");
        await grant(
            "stale",
            ["use", "org.curate"],
            "active",
            new Date(Date.now() - 3600_000),
        );
        await grant("without-use", ["org.curate"]);
        await grant("org");
        await db().insert(users).values({
            id: "deleted",
            name: "Deleted",
            email: "deleted@example.com",
        });
        await grant("deleted");
        await db().delete(users).where(eq(users.id, "deleted"));
        await setCreator("bela");
        expect(await (await read()).json()).toEqual({
            curators: [ada, bela],
            creator: null,
        });
    });
    it("keeps a non-curator creator separate in idp mode", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await grant("ada");
        await grant("bela", ["use"]);
        await setCreator("bela");
        expect(await (await read()).json()).toEqual({
            curators: [ada],
            creator: bela,
        });
    });
    it.each([
        "suspended",
        "disabled",
        "without-use",
        "unverified",
    ])("omits an ineligible creator: %s", async (creator) => {
        mockEnv.AUTHZ_MODE = "idp";
        await grant("ada");
        if (creator === "disabled") await grant(creator, ["use"], "disabled");
        if (creator === "without-use") await grant(creator, []);
        await setCreator(creator);
        expect(await (await read()).json()).toEqual({
            curators: [ada],
            creator: null,
        });
    });
    it("omits a suspended local creator", async () => {
        await setCreator("suspended");
        expect(await (await read()).json()).toEqual({
            curators: [orgContact],
            creator: null,
        });
    });
    it("returns an empty list when there are no curators", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        expect(await (await read()).json()).toEqual({
            curators: [],
            creator: null,
        });
    });
    it("does not list a suspended local Organization account", async () => {
        await db()
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, "org"));
        expect(await (await read()).json()).toEqual({
            curators: [],
            creator: null,
        });
    });
    it("does not verify or write access state for 50 stale curator candidates", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await grant("ada");
        for (let i = 0; i < 50; i++) {
            const id = `stale-curator-${i}`;
            await db()
                .insert(users)
                .values({
                    id,
                    name: `A stale ${i}`,
                    email: `${id}@example.com`,
                });
            await grant(id, ["use", "org.curate"], "active", new Date(0));
            await db().insert(accounts).values({
                userId: id,
                providerId: "oidc",
                accountId: id,
                issuer: "https://id.example.com",
            });
        }
        const before = await db()
            .select()
            .from(userAccessStates)
            .orderBy(userAccessStates.userId);
        const writes = [
            vi.spyOn(db(), "insert"),
            vi.spyOn(db(), "update"),
            vi.spyOn(db(), "delete"),
        ];
        try {
            const response = await read();
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                curators: [ada],
                creator: null,
            });
            expect(verify).not.toHaveBeenCalled();
            for (const write of writes) expect(write).not.toHaveBeenCalled();
            expect(
                await db()
                    .select()
                    .from(userAccessStates)
                    .orderBy(userAccessStates.userId),
            ).toEqual(before);
        } finally {
            for (const write of writes) write.mockRestore();
        }
    });
    it("omits a stale curator-creator without verifying or changing their state", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        verify.mockResolvedValue({ status: "disabled" });
        await grant("ada");
        await grant("bela", ["use", "org.curate"], "active", new Date(0));
        await db().insert(accounts).values({
            userId: "bela",
            providerId: "oidc",
            accountId: "bela",
            issuer: "https://id.example.com",
        });
        await setCreator("bela");
        expect(await (await read()).json()).toEqual({
            curators: [ada],
            creator: null,
        });
        expect(verify).not.toHaveBeenCalled();
        expect(
            await db()
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, "bela")),
        ).toMatchObject([
            { status: "active", verifiedAt: new Date(0), source: "login" },
        ]);
    });
    it.each([
        0, 1,
    ])("applies the stored verification-age boundary to curator and creator (%s ms fresh)", async (freshMs) => {
        mockEnv.AUTHZ_MODE = "idp";
        const now = Date.now();
        await grant(
            "ada",
            ["use", "org.curate"],
            "active",
            new Date(now - 1800_000 + freshMs),
        );
        await grant(
            "bela",
            ["use"],
            "active",
            new Date(now - 1800_000 + freshMs),
        );
        await setCreator("bela");
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
            expect(await (await read()).json()).toEqual({
                curators: freshMs ? [ada] : [],
                creator: freshMs ? bela : null,
            });
        } finally {
            clock.mockRestore();
        }
    });
    it("does not refresh a stale caller to read restricted contacts", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await grant("member", ["use", "org.curate"], "active", new Date(0));
        await db().insert(accounts).values({
            userId: "member",
            providerId: "oidc",
            accountId: "member",
            issuer: "https://id.example.com",
        });
        expect((await read("locked")).status).toBe(404);
        expect(verify).not.toHaveBeenCalled();
        expect(await db().select().from(userAccessStates)).toMatchObject([
            { verifiedAt: new Date(0) },
        ]);
    });
    it("caps the sorted curator list at 50", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        for (let i = 0; i < 55; i++) {
            const id = `curator-${String(i).padStart(2, "0")}`;
            await db()
                .insert(users)
                .values({ id, name: id, email: `${id}@example.com` });
            await grant(id);
        }
        await setCreator("curator-54");
        const result = await (await read()).json();
        expect(result.creator).toEqual({
            id: "curator-54",
            name: "curator-54",
            email: "curator-54@example.com",
        });
        expect(result.curators).toHaveLength(50);
        expect(result.curators[0].id).toBe("curator-00");
        expect(result.curators[49].id).toBe("curator-49");
    });
});
