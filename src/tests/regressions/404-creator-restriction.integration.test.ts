import { eq, sql } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { GET as audienceGET } from "@/app/api/folders/[id]/audience/route";
import { GET, POST } from "@/app/api/folders/[id]/restrict/route";
import {
    asyncJobs,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    userAccessStates,
    users,
} from "@/db/schema";
import { recordAccessState } from "@/lib/authz/access-state";
import type { Capability } from "@/lib/authz/catalog";
import { encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    listFolderOrganization,
    listRecordingFolderTrees,
} from "@/lib/folders/folders";
import {
    changeFolderRestriction,
    processRestrictedFolderItem,
} from "@/lib/folders/restricted-folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording } from "@/tests/mcp/fixtures";

const { dbProxy, dbRef, state, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
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
    getAccessVerifier: () => null,
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

vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/org/events", () => ({
    notifyOrgChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("creator restriction authority (#404)", () => {
    let database: TestPostgresDatabase;
    function db() {
        return database.db;
    }
    const context = { params: Promise.resolve({ id: "open" }) };
    function request() {
        return new Request(
            "https://app.example.com/api/folders/open/restrict",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ audienceUserIds: [] }),
            },
        );
    }
    async function grant(
        userId: string,
        capabilities: Capability[] = ["use"],
        status: "active" | "disabled" | "missing" = "active",
    ) {
        await recordAccessState({
            userId,
            capabilities,
            status,
            issuer: "https://id.example.com",
            subject: userId,
            source: "access-change",
        });
    }
    async function idp() {
        mockEnv.AUTHZ_MODE = "idp";
        for (const id of ["creator", "member", "owner", "curator"])
            await grant(id, id === "curator" ? ["use", "org.curate"] : ["use"]);
    }
    async function addItem(id: string) {
        await insertRecording(db(), { id, userId: "owner" });
        await db()
            .insert(recordingFolderAssignments)
            .values({ folderId: "open", itemId: id, userId: "owner" });
    }
    async function forbid() {
        expect(
            (
                await GET(
                    new Request(
                        "https://app.example.com/api/folders/open/restrict",
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
        expect((await POST(request(), context)).status).toBe(403);
        expect(await db().select().from(restrictedFolderMembers)).toEqual([]);
        expect(await db().select().from(asyncJobs)).toEqual([]);
        expect(
            (
                await db()
                    .select()
                    .from(recordingFolders)
                    .where(eq(recordingFolders.id, "open"))
            )[0],
        ).toMatchObject({ restrictedAt: null, restrictingAt: null });
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "creator_restriction_404",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        state.userId = "creator";
        state.signedIn = true;
        mockEnv.AUTHZ_MODE = "local";
        mockEnv.SELF_HOST_MODE = "shared";
        mockEnv.ORG_ACCOUNT_PASSWORD = "test-password";
        await db().delete(asyncJobs);
        await db().delete(recordingFolders);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                {
                    id: "org",
                    email: "org@example.com",
                    name: "Organization",
                    role: "org",
                },
                ...["creator", "member", "owner", "curator"].map((id) => ({
                    id,
                    name: id,
                    email: `${id}@example.com`,
                })),
            ]);
        for (const folder of [
            { id: "root", kind: "public" as const, parentId: null },
            {
                id: "open",
                kind: "custom" as const,
                parentId: "root",
                createdByUserId: "creator",
            },
        ])
            await db()
                .insert(recordingFolders)
                .values({
                    ...folder,
                    userId: "org",
                    name: encryptText(folder.id),
                    nameHash: lookupHash(folder.id),
                });
    });
    it.each([
        "local",
        "idp",
    ])("lets the %s creator preview and restrict, becoming manager while other owners join", async (mode) => {
        if (mode === "idp") await idp();
        await addItem("recording");
        const preview = await GET(
            new Request("https://app.example.com/api/folders/open/restrict"),
            context,
        );
        expect(preview.status).toBe(200);
        expect(await preview.json()).toMatchObject({
            withdrawnItems: [{ id: "recording", ownerUserId: "owner" }],
        });
        const response = await POST(request(), context);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            restricted: true,
            restricting: false,
        });
        expect(await db().select().from(restrictedFolderMembers)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    userId: "creator",
                    role: "manager",
                    addedByUserId: "creator",
                }),
                expect.objectContaining({ userId: "owner", role: "member" }),
            ]),
        );
        expect(
            await db().select().from(recordingFolderAssignments),
        ).toMatchObject([{ withheld: true }]);
    });
    it.each([
        "org",
        "curator",
    ])("keeps restriction authority for curator %s", async (caller) => {
        if (caller === "curator") await idp();
        state.userId = caller;
        expect((await POST(request(), context)).status).toBe(200);
        expect(await db().select().from(restrictedFolderMembers)).toMatchObject(
            [{ userId: caller, role: "manager" }],
        );
    });
    it.each([
        "local",
        "idp",
    ])("refuses another %s member with 403", async (mode) => {
        if (mode === "idp") await idp();
        state.userId = "member";
        await forbid();
    });
    it.each([
        "suspended",
        "disabled",
        "missing",
        "use",
        "unverified",
    ])("refuses a creator who lost %s before preview", async (loss) => {
        await idp();
        if (loss === "suspended")
            await db()
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "creator"));
        else if (loss === "unverified")
            await db()
                .delete(userAccessStates)
                .where(eq(userAccessStates.userId, "creator"));
        else
            await grant(
                "creator",
                loss === "use" ? [] : ["use"],
                loss === "disabled" || loss === "missing" ? loss : "active",
            );
        await forbid();
    });
    it("refuses a suspended local creator", async () => {
        await db()
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, "creator"));
        await forbid();
    });
    it.each([
        "suspended",
        "disabled",
        "missing",
        "use",
        "creator",
    ])("rechecks loss of %s between preflight and the tree lock", async (loss) => {
        await idp();
        const gate = await database.sql.reserve();
        const key = 404002;
        await gate`select pg_advisory_lock(${key})`;
        const transaction = db().transaction.bind(db());
        const spy = vi.spyOn(db(), "transaction");
        spy.mockImplementationOnce((run, options) =>
            transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
                return run(tx);
            }, options),
        );
        const outcome = POST(request(), context);
        try {
            await expect
                .poll(async () => {
                    const [row] =
                        await database.sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${key} and not granted and database = (select oid from pg_database where datname = current_database())`;
                    return row.n;
                })
                .toBe(1);
            if (loss === "suspended")
                await db()
                    .update(users)
                    .set({ suspendedAt: new Date() })
                    .where(eq(users.id, "creator"));
            else if (loss === "creator")
                await db()
                    .update(recordingFolders)
                    .set({ createdByUserId: "member" })
                    .where(eq(recordingFolders.id, "open"));
            else
                await grant(
                    "creator",
                    loss === "use" ? [] : ["use"],
                    loss === "disabled" || loss === "missing" ? loss : "active",
                );
        } finally {
            await gate`select pg_advisory_unlock(${key})`;
            gate.release();
            spy.mockRestore();
        }
        expect((await outcome).status).toBe(403);
        expect(await db().select().from(asyncJobs)).toEqual([]);
        expect(await db().select().from(restrictedFolderMembers)).toEqual([]);
        expect(
            (
                await db()
                    .select()
                    .from(recordingFolders)
                    .where(eq(recordingFolders.id, "open"))
            )[0],
        ).toMatchObject({ restrictedAt: null, restrictingAt: null });
    });
    it("lets a creator retry an in-progress restriction and keeps the manager and epoch", async () => {
        await idp();
        for (let i = 0; i < 26; i++) await addItem(`recording-${i}`);
        expect(
            await changeFolderRestriction("creator", "open", "restrict"),
        ).toMatchObject({
            restricted: false,
            restricting: true,
            processed: 25,
            queued: 1,
        });
        const [pending] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, "open"));
        state.userId = "member";
        expect((await POST(request(), context)).status).toBe(403);
        state.userId = "creator";
        expect((await POST(request(), context)).status).toBe(200);
        const [done] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, "open"));
        expect(done.restrictedAt).toEqual(pending.restrictingAt);
        expect(done.restrictingAt).toBeNull();
        expect(
            await db()
                .select()
                .from(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.userId, "creator")),
        ).toMatchObject([{ role: "manager" }]);
        await processRestrictedFolderItem({
            folderId: "open",
            itemId: "recording-25",
            ownerUserId: "owner",
            operation: "restrict",
            restriction: pending.restrictingAt?.toISOString() ?? "",
        });
        expect(await db().select().from(recordingFolderAssignments)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    itemId: "recording-25",
                    withheld: true,
                }),
            ]),
        );
    });
    it.each([
        false,
        true,
    ])("makes the creator manager when retrying a curator-started transition (already a member: %s)", async (included) => {
        await idp();
        for (let i = 0; i < 26; i++) await addItem(`recording-${i}`);
        expect(
            await changeFolderRestriction(
                "curator",
                "open",
                "restrict",
                included ? ["creator", "member"] : ["member"],
            ),
        ).toMatchObject({ restricting: true, queued: 1 });
        const [pending] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, "open"));
        const before = await db()
            .select()
            .from(restrictedFolderMembers)
            .orderBy(restrictedFolderMembers.userId);
        expect(before.find((person) => person.userId === "creator")?.role).toBe(
            included ? "member" : undefined,
        );
        const preview = await GET(
            new Request("https://app.example.com/api/folders/open/restrict"),
            context,
        );
        expect(preview.status).toBe(200);
        expect(await preview.json()).toMatchObject({
            audience: expect.arrayContaining([
                {
                    id: "curator",
                    name: "curator",
                    email: "curator@example.com",
                },
                { id: "member", name: "member", email: "member@example.com" },
                { id: "owner", name: "owner", email: "owner@example.com" },
            ]),
        });
        expect(
            (
                await audienceGET(
                    new Request(
                        "https://app.example.com/api/folders/open/audience",
                    ),
                    context,
                )
            ).status,
        ).toBe(included ? 200 : 404);
        expect(
            await db()
                .select()
                .from(restrictedFolderMembers)
                .orderBy(restrictedFolderMembers.userId),
        ).toEqual(before);
        state.userId = "member";
        expect(
            (
                await GET(
                    new Request(
                        "https://app.example.com/api/folders/open/restrict",
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
        state.userId = "creator";
        const response = await POST(request(), context);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            restricted: true,
            restricting: false,
        });
        const [done] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, "open"));
        expect(done.restrictedAt).toEqual(pending.restrictingAt);
        expect(done.restrictingAt).toBeNull();
        const after = await db()
            .select()
            .from(restrictedFolderMembers)
            .orderBy(restrictedFolderMembers.userId);
        expect(
            after.filter((person) => person.userId === "creator"),
        ).toMatchObject([
            {
                role: "manager",
                addedByUserId: included ? "curator" : "creator",
            },
        ]);
        expect(after.filter((person) => person.userId !== "creator")).toEqual(
            before.filter((person) => person.userId !== "creator"),
        );
        expect(
            (
                await audienceGET(
                    new Request(
                        "https://app.example.com/api/folders/open/audience",
                    ),
                    context,
                )
            ).status,
        ).toBe(200);
    });
    it("keeps ordinary restricted audience reads protected from creators outside the audience", async () => {
        await idp();
        await changeFolderRestriction("curator", "open", "restrict");
        expect(
            (
                await audienceGET(
                    new Request(
                        "https://app.example.com/api/folders/open/audience",
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
        expect(
            (
                await GET(
                    new Request(
                        "https://app.example.com/api/folders/open/restrict",
                    ),
                    context,
                )
            ).status,
        ).toBe(403);
    });
    it.each([
        "creator",
        "member",
        "curator",
    ])("computes caller flags for %s in both tree payloads", async (caller) => {
        await idp();
        for (const list of [listRecordingFolderTrees, listFolderOrganization]) {
            const result = await list(caller);
            const folders = Array.isArray(result) ? result : result.folders;
            expect(
                folders.find((folder) => folder.id === "open")?.canRestrict,
            ).toBe(caller !== "member");
            expect(
                folders.find((folder) => folder.id === "root")?.canRestrict,
            ).toBeUndefined();
        }
    });
    it("clears creator flags after loss of use", async () => {
        await idp();
        await grant("creator", []);
        expect(
            (await listRecordingFolderTrees("creator")).find(
                (folder) => folder.id === "open",
            )?.canRestrict,
        ).toBe(false);
    });
    it("keeps the leaf rule for the creator", async () => {
        await db()
            .insert(recordingFolders)
            .values({
                id: "child",
                userId: "org",
                kind: "custom",
                parentId: "open",
                name: encryptText("Child"),
                nameHash: lookupHash("Child"),
            });
        expect((await POST(request(), context)).status).toBe(409);
        expect(await db().select().from(restrictedFolderMembers)).toEqual([]);
    });
    it("keeps Organization writable enforcement for the creator", async () => {
        mockEnv.ORG_ACCOUNT_PASSWORD = "";
        expect((await POST(request(), context)).status).toBe(403);
    });
    it("does not grant lift authority to a creator who is only an audience member", async () => {
        await changeFolderRestriction("org", "open", "restrict", ["creator"]);
        await expect(
            changeFolderRestriction("creator", "open", "lift"),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});
