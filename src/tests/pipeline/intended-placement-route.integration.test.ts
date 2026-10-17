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
    itemProcessing,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { authState, dbProxy, dbRef, mockEnv, nudge } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        authState: { userId: "intent-route-owner" },
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared" as const,
            ORG_ACCOUNT_EMAIL: "intent-route-org@example.test",
            ORG_ACCOUNT_PASSWORD: "password",
            DATABASE_URL: "postgres://unused",
        },
        nudge: vi.fn(),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: {
            id: authState.userId,
            email: `${authState.userId}@example.test`,
        },
        session: { id: `session-${authState.userId}` },
    }),
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

import { DELETE } from "@/app/api/recordings/[id]/intended-placements/[folderId]/route";
import { POST } from "@/app/api/recordings/[id]/intended-placements/confirm/route";
import { db as appDb } from "@/db";
import { recordIntendedPlacementInTx } from "@/lib/pipeline/share-intent";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "intent-route-owner";
const MEMBER = "intent-route-member";
const ORG = "intent-route-org";
const ITEM = "intent-route-item";
const SHARED_FOLDER = "intent-route-shared";
const INTENDED_FOLDER = "intent-route-intended";

function request() {
    return new Request(
        `https://app.example.test/api/recordings/${ITEM}/intended-placements/${INTENDED_FOLDER}`,
        { method: "DELETE" },
    );
}

function context() {
    return {
        params: Promise.resolve({ id: ITEM, folderId: INTENDED_FOLDER }),
    };
}

function confirmRequest() {
    return new Request(
        `https://app.example.test/api/recordings/${ITEM}/intended-placements/confirm`,
        { method: "POST" },
    );
}

function confirmContext() {
    return { params: Promise.resolve({ id: ITEM }) };
}

describeWithDatabase("DELETE intended placement route", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function intentExists() {
        const [row] = await db()
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, ITEM),
                    eq(mailPendingShares.userId, OWNER),
                    eq(mailPendingShares.folderId, INTENDED_FOLDER),
                ),
            )
            .limit(1);
        return row !== undefined;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "intended_placement_route",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        authState.userId = OWNER;
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test", name: "Owner" },
                { id: MEMBER, email: "member@example.test", name: "Member" },
                {
                    id: ORG,
                    email: "intent-route-org@example.test",
                    name: "Organization",
                    role: "org",
                },
            ]);
        await db()
            .insert(recordingFolders)
            .values([
                {
                    id: "intent-route-org-root",
                    userId: ORG,
                    parentId: null,
                    name: "Organization",
                    nameHash: "org-root",
                    kind: "public",
                },
                {
                    id: SHARED_FOLDER,
                    userId: ORG,
                    parentId: "intent-route-org-root",
                    name: "Shared",
                    nameHash: "shared",
                    kind: "custom",
                },
                {
                    id: INTENDED_FOLDER,
                    userId: ORG,
                    parentId: "intent-route-org-root",
                    name: "Sales",
                    nameHash: "sales",
                    kind: "custom",
                },
            ]);
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM,
                userId: OWNER,
                kind: "mail",
                title: "Mail",
                occurredAt: new Date("2026-10-15T10:00:00Z"),
            });
        await db().insert(recordingFolderAssignments).values({
            itemId: ITEM,
            userId: OWNER,
            folderId: SHARED_FOLDER,
        });
        await appDb.transaction((tx) =>
            recordIntendedPlacementInTx(tx, {
                ownerUserId: OWNER,
                itemId: ITEM,
                folderId: INTENDED_FOLDER,
            }),
        );
    });

    it("lets only the owner cancel and marks the last Share intent cancelled", async () => {
        const response = await DELETE(request(), context());
        expect(response.status).toBe(200);
        expect(await intentExists()).toBe(false);
        const [processing] = await db()
            .select({ phases: itemProcessing.phases })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .limit(1);
        expect(processing?.phases.share).toMatchObject({
            state: "skipped",
            reason: "cancelled",
        });
    });

    it.each([
        MEMBER,
        ORG,
    ])("returns 404 to %s and keeps the intent", async (userId) => {
        authState.userId = userId;
        const response = await DELETE(request(), context());
        expect(response.status).toBe(404);
        expect(await intentExists()).toBe(true);
    });

    it("confirms every current intent of the owner's manual-only item", async () => {
        await db()
            .update(itemProcessing)
            .set({ manualOnly: true })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );

        const response = await POST(confirmRequest(), confirmContext());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ confirmed: 1 });
        const [intent] = await db()
            .select({ confirmedAt: mailPendingShares.confirmedAt })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, ITEM),
                    eq(mailPendingShares.userId, OWNER),
                ),
            );
        expect(intent?.confirmedAt).toBeInstanceOf(Date);
        expect(nudge).toHaveBeenCalled();
    });

    it("returns 404 when another user confirms the owner's item", async () => {
        await db()
            .update(itemProcessing)
            .set({ manualOnly: true })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );
        authState.userId = MEMBER;

        const response = await POST(confirmRequest(), confirmContext());
        expect(response.status).toBe(404);
    });

    it("returns 409 for an automatic item or when nothing remains to confirm", async () => {
        const automatic = await POST(confirmRequest(), confirmContext());
        expect(automatic.status).toBe(409);

        await db()
            .update(itemProcessing)
            .set({ manualOnly: true })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            );
        await DELETE(request(), context());
        const empty = await POST(confirmRequest(), confirmContext());
        expect(empty.status).toBe(409);
    });
});
