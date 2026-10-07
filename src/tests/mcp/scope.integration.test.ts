/**
 * Which rows an MCP caller reads, against a real PostgreSQL: a user their
 * own recordings and the Organization-shared ones, a service caller the
 * shared ones alone, nobody another user's private ones or anything
 * deleted.
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
import { recordings, users } from "@/db/schema";
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
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import {
    knowledgeContextFor,
    mcpRecordingCondition,
    recordingViewFor,
    taskViewerFor,
} from "@/lib/mcp/scope";
import { ensureOrgAccount } from "@/lib/org/account";
import {
    insertRecording,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

describeWithDatabase("MCP caller scopes (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = () =>
        userCaller(
            ALICE,
            "alice@example.test",
            ["transcripts:read"],
            orgUserId,
        );
    const bob = () =>
        userCaller(BOB, "bob@example.test", ["transcripts:read"], orgUserId);
    const service = () => serviceCaller(orgUserId, ["tasks:read"]);

    async function readable(caller: McpCaller): Promise<string[]> {
        const rows = await db()
            .select({ id: recordings.id })
            .from(recordings)
            .where(mcpRecordingCondition(caller));
        return rows.map((row) => row.id).sort();
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_scope",
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
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");
        await insertRecording(db(), { id: "r1", userId: ALICE });
        await insertRecording(db(), { id: "r2", userId: BOB });
        await insertRecording(db(), { id: "r3", userId: BOB });
        await insertRecording(db(), {
            id: "r4",
            userId: ALICE,
            deletedAt: new Date("2026-09-02T10:00:00Z"),
        });
        await shareRecording(db(), "r3", orgUserId);
    });

    it("lets a user read their own recordings and the shared ones", async () => {
        expect(await readable(alice())).toEqual(["r1", "r3"]);
        expect(await readable(bob())).toEqual(["r2", "r3"]);
    });

    it("lets a service caller read the shared recordings alone", async () => {
        expect(await readable(service())).toEqual(["r3"]);
    });

    it("hides a deleted recording from everyone", async () => {
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, "r3"));
        expect(await readable(alice())).toEqual(["r1"]);
        expect(await readable(bob())).toEqual(["r2"]);
        expect(await readable(service())).toEqual([]);
    });

    it("keeps a user to their own recordings without an Organization", async () => {
        const local = userCaller(
            ALICE,
            "alice@example.test",
            ["transcripts:read"],
            null,
        );
        expect(await readable(local)).toEqual(["r1"]);
    });

    it("reads someone else's recording in the Organization view", () => {
        expect(recordingViewFor(alice(), BOB)).toBe("org");
        expect(recordingViewFor(bob(), BOB)).toBe("private");
        expect(recordingViewFor(service(), BOB)).toBe("org");
    });

    it("reads knowledge as the user, or as the Organization", () => {
        expect(knowledgeContextFor(alice())).toEqual({
            kind: "pages",
            viewerUserId: ALICE,
        });
        expect(knowledgeContextFor(service())).toEqual({
            kind: "pages",
            viewerUserId: orgUserId,
        });
    });

    it("acts on tasks as the user, or as the organization account", async () => {
        await expect(taskViewerFor(alice())).resolves.toEqual({
            userId: ALICE,
            emailHash: lookupHash("alice@example.test"),
            isOrg: false,
            orgUserId,
        });
        await expect(taskViewerFor(service())).resolves.toEqual({
            userId: orgUserId,
            emailHash: lookupHash("org@example.test"),
            isOrg: true,
            orgUserId,
        });
    });
});
