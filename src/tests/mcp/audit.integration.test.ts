/**
 * The external MCP server's access log, against a real PostgreSQL: what a
 * call writes, and what the pruner removes.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { mcpAccessLog, users } from "@/db/schema";
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
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            MCP_AUDIT_RETENTION_DAYS: 90,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { pruneMcpAccessLog } from "@/db/queries/mcp-audit";
import { recordMcpAccess } from "@/lib/mcp/audit";
import type { McpCaller } from "@/lib/mcp/caller";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const ORG = "user-org";
const DAY_MS = 86_400_000;

const alice: McpCaller = {
    kind: "user",
    userId: ALICE,
    email: "alice@example.test",
    subject: "alice-sub",
    clientId: "claude",
    roles: new Set(["tasks:read"]),
    orgUserId: ORG,
};

const bot: McpCaller = {
    kind: "service",
    subject: "sa-uuid",
    clientId: "intranet-bot",
    roles: new Set(["tasks:read"]),
    orgUserId: ORG,
};

describeWithDatabase("the MCP access log (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_audit",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(mcpAccessLog);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: ORG, email: "org@example.test", role: "org" },
            ]);
    });

    it("records a user call with its targets, once each", async () => {
        await recordMcpAccess({
            caller: alice,
            tool: "list_tasks",
            outcome: "ok",
            targetIds: ["t1", "t2", "t1"],
            ip: "203.0.113.7",
        });
        const rows = await db().select().from(mcpAccessLog);
        expect(rows).toEqual([
            expect.objectContaining({
                callerKind: "user",
                userId: ALICE,
                subject: "alice-sub",
                clientId: "claude",
                tool: "list_tasks",
                outcome: "ok",
                targetIds: ["t1", "t2"],
                ip: "203.0.113.7",
            }),
        ]);
    });

    it("names no user for a service caller", async () => {
        await recordMcpAccess({
            caller: bot,
            tool: "update_task",
            outcome: "conflict",
            targetIds: ["t9"],
            ip: null,
        });
        const [row] = await db().select().from(mcpAccessLog);
        expect(row).toMatchObject({
            callerKind: "service",
            userId: null,
            subject: "sa-uuid",
            clientId: "intranet-bot",
            outcome: "conflict",
            targetIds: ["t9"],
        });
    });

    it("records a refusal by the token's subject and client", async () => {
        await recordMcpAccess({
            caller: null,
            subject: "stranger",
            clientId: "cursor",
            tool: null,
            outcome: "denied",
            ip: null,
        });
        const [row] = await db().select().from(mcpAccessLog);
        expect(row).toMatchObject({
            callerKind: null,
            userId: null,
            subject: "stranger",
            clientId: "cursor",
            tool: null,
            outcome: "denied",
            targetIds: [],
        });
    });

    it("keeps at most 200 targets", async () => {
        await recordMcpAccess({
            caller: alice,
            tool: "list_recordings",
            outcome: "ok",
            targetIds: Array.from({ length: 250 }, (_, i) => `r${i}`),
            ip: null,
        });
        const [row] = await db().select().from(mcpAccessLog);
        expect(row?.targetIds).toHaveLength(200);
    });

    it("never throws when the write fails", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(
            recordMcpAccess({
                caller: { ...alice, userId: "no-such-user" },
                tool: "list_tasks",
                outcome: "ok",
                ip: null,
            }),
        ).resolves.toBeUndefined();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    it("prunes rows past the retention", async () => {
        const now = Date.now();
        await db()
            .insert(mcpAccessLog)
            .values([
                { at: new Date(now - 100 * DAY_MS), outcome: "ok" },
                { at: new Date(now - 91 * DAY_MS), outcome: "denied" },
                { at: new Date(now - DAY_MS), outcome: "ok" },
            ]);
        await expect(pruneMcpAccessLog(90)).resolves.toBe(2);
        const left = await db().select().from(mcpAccessLog);
        expect(left).toHaveLength(1);
        await expect(pruneMcpAccessLog(90)).resolves.toBe(0);
    });

    it("prunes in batches", async () => {
        const old = new Date(Date.now() - 200 * DAY_MS);
        await db()
            .insert(mcpAccessLog)
            .values(
                Array.from({ length: 5 }, () => ({
                    at: old,
                    outcome: "ok" as const,
                })),
            );
        await expect(pruneMcpAccessLog(90, 3)).resolves.toBe(3);
        await expect(pruneMcpAccessLog(90, 3)).resolves.toBe(2);
    });
});
