/**
 * The vocabulary routes an account tends its own types with, against a
 * real PostgreSQL: rename, keep, delete and merge, each only on the
 * caller's own types.
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
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeRelationTypes,
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

import {
    DELETE as deleteTypeRoute,
    GET as mergeCountRoute,
    POST as mergeTypeRoute,
    PATCH as patchTypeRoute,
} from "@/app/api/knowledge/types/[kind]/[key]/route";
import { createEntity } from "@/lib/knowledge/entities";
import {
    createPrivateType,
    listOwnTypes,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function call(
    handler: unknown,
    user: string | null,
    { kind, key }: { kind: string; key: string },
    init: RequestInit & { query?: string } = {},
) {
    const { query = "", ...rest } = init;
    const headers = new Headers(rest.headers);
    if (user) headers.set("x-test-user", user);
    return (handler as Handler)(
        new Request(
            `http://localhost/api/knowledge/types/${kind}/${key}${query}`,
            { ...rest, headers },
        ),
        { params: Promise.resolve({ kind, key }) },
    );
}

function json(method: string, body: unknown): RequestInit {
    return {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

describeWithDatabase("the vocabulary routes (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "vocabulary_routes",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(knowledgeRelationTypes);
        await db().delete(knowledgeEntityTypes);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        await ensureOrgAccount();
        await seedCoreVocabulary();
    });

    it("renames, keeps, merges and deletes the caller's own types", async () => {
        const gadget = {
            kind: "entity",
            key: await createPrivateType(ALICE, {
                kind: "entity",
                label: "gadget",
            }),
        };
        const gizmo = {
            kind: "entity",
            key: await createPrivateType(ALICE, {
                kind: "entity",
                label: "gizmo",
            }),
        };
        await db()
            .update(knowledgeEntityTypes)
            .set({ adoptedFromShare: true })
            .where(eq(knowledgeEntityTypes.key, gizmo.key));
        await createEntity(ALICE, { typeKey: gadget.key, name: "Toaster" });
        await createEntity(ALICE, { typeKey: gizmo.key, name: "Toaster" });

        const renamed = await call(
            patchTypeRoute,
            ALICE,
            gadget,
            json("PATCH", { label: "appliance" }),
        );
        expect(renamed.status).toBe(200);
        const kept = await call(
            patchTypeRoute,
            ALICE,
            gizmo,
            json("PATCH", { keep: true }),
        );
        expect(kept.status).toBe(200);
        expect(
            (await listOwnTypes(ALICE)).map((type) => [
                type.label,
                type.adoptedFromShare,
            ]),
        ).toEqual([
            ["appliance", false],
            ["gizmo", false],
        ]);

        // The count first, then the merge that confirms it.
        const counted = await call(mergeCountRoute, ALICE, gizmo, {
            query: `?mergeInto=${gadget.key}`,
        });
        expect(await counted.json()).toEqual({ count: 1 });
        const stale = await call(
            mergeTypeRoute,
            ALICE,
            gizmo,
            json("POST", { mergeInto: gadget.key, confirmCount: 0 }),
        );
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ details: { count: 1 } });
        const merged = await call(
            mergeTypeRoute,
            ALICE,
            gizmo,
            json("POST", { mergeInto: gadget.key, confirmCount: 1 }),
        );
        expect(merged.status).toBe(200);

        const deleted = await call(
            deleteTypeRoute,
            ALICE,
            gadget,
            json("DELETE", { confirmCount: 1 }),
        );
        expect(deleted.status).toBe(200);
        expect(await listOwnTypes(ALICE)).toEqual([]);
        // The Toaster the merge joined went with its tombstone.
        expect(
            await db()
                .select({ id: knowledgeEntities.id })
                .from(knowledgeEntities),
        ).toEqual([]);
    });

    it("answers another account's type, a core type and an unknown kind as not found", async () => {
        const gadget = {
            kind: "entity",
            key: await createPrivateType(ALICE, {
                kind: "entity",
                label: "gadget",
            }),
        };
        const attempts = [
            call(patchTypeRoute, BOB, gadget, json("PATCH", { label: "x" })),
            call(patchTypeRoute, BOB, gadget, json("PATCH", { keep: true })),
            call(
                deleteTypeRoute,
                BOB,
                gadget,
                json("DELETE", { confirmCount: 0 }),
            ),
            call(
                mergeTypeRoute,
                BOB,
                gadget,
                json("POST", { mergeInto: "project", confirmCount: 0 }),
            ),
            call(mergeCountRoute, BOB, gadget, { query: "?mergeInto=project" }),
            call(
                patchTypeRoute,
                ALICE,
                { kind: "entity", key: "project" },
                json("PATCH", { label: "venture" }),
            ),
            call(
                patchTypeRoute,
                ALICE,
                { kind: "gadget", key: gadget.key },
                json("PATCH", { label: "x" }),
            ),
        ];
        expect(
            (await Promise.all(attempts)).map((response) => response.status),
        ).toEqual([404, 404, 404, 404, 404, 404, 404]);
        expect((await listOwnTypes(ALICE))[0]?.label).toBe("gadget");
    });

    it("refuses what it cannot read, and anyone signed out", async () => {
        const gadget = {
            kind: "entity",
            key: await createPrivateType(ALICE, {
                kind: "entity",
                label: "gadget",
            }),
        };
        const statuses = await Promise.all([
            call(deleteTypeRoute, ALICE, gadget, json("DELETE", {})),
            call(
                mergeTypeRoute,
                ALICE,
                gadget,
                json("POST", { confirmCount: 0 }),
            ),
            call(patchTypeRoute, ALICE, gadget, json("PATCH", { label: " " })),
            call(mergeCountRoute, ALICE, gadget),
            call(patchTypeRoute, null, gadget, json("PATCH", { keep: true })),
        ]);
        expect(statuses.map((response) => response.status)).toEqual([
            400, 400, 400, 400, 401,
        ]);
    });
});
