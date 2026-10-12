/**
 * The external MCP endpoint, against a real PostgreSQL: who gets in, what
 * a refused caller is told, which tools a caller sees, and the access-log
 * row every call leaves.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { asc } from "drizzle-orm";
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
import { z } from "zod";
import {
    accounts,
    apiRateLimitBuckets,
    mcpAccessLog,
    users,
} from "@/db/schema";
import type { McpToolDef } from "@/lib/mcp/registry";
import type { McpTokenCheck, McpTokenClaims } from "@/lib/mcp/token";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, baseEnv, verify, fakeTools } = vi.hoisted(
    () => {
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
        const base = {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
            APP_URL: "https://riffado.example.com",
            RATE_LIMIT_TRUST_PROXY_HEADERS: true,
            OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "secret",
            MCP_AUDIENCE: "riffado-mcp" as string | undefined,
            MCP_ALLOWED_CLIENTS: [] as string[],
            MCP_PUBLIC_INGRESS_HEADER: undefined as string | undefined,
            MCP_PUBLIC_CLIENTS: [] as string[],
            MCP_CONNECTOR_KEYS: [] as { client: string; key: string }[],
        };
        return {
            dbProxy: proxy,
            dbRef: ref,
            baseEnv: base,
            mockEnv: { ...base } as Record<string, unknown>,
            verify: vi.fn<(token: string) => Promise<McpTokenCheck>>(),
            fakeTools: [] as McpToolDef[],
        };
    },
);

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/mcp/token", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    verifyMcpToken: verify,
}));
vi.mock("@/lib/mcp/tools", () => ({ ALL_TOOLS: fakeTools }));

import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { MCP_MAX_BODY_BYTES } from "@/lib/mcp/config";
import { MCP_CALLER_LIMIT } from "@/lib/mcp/rate-limit";
import { defineTool } from "@/lib/mcp/registry";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const IP = "203.0.113.7";
const CONNECTOR_KEY = "0123456789abcdef0123456789abcdef";
const PUBLIC = { "x-mcp-ingress": "public" };
const CHALLENGE =
    'resource_metadata="https://riffado.example.com/.well-known/oauth-protected-resource/api/mcp", scope="openid"';
const SECRET = "decrypted transcript text";

fakeTools.push(
    defineTool({
        name: "note_lookup",
        anyOf: ["knowledge:read"],
        title: "Look up a note",
        description: "Finds a note by name.",
        annotations: { readOnlyHint: true },
        input: { name: z.string() },
        output: { id: z.string(), name: z.string() },
        run: async (context, args) => {
            context.touched.push("ent-1");
            return { id: "ent-1", name: args.name };
        },
    }),
    defineTool({
        name: "task_peek",
        anyOf: ["tasks:read"],
        title: "Peek at tasks",
        description: "Counts tasks.",
        annotations: { readOnlyHint: true },
        input: {},
        output: { count: z.number() },
        run: async () => ({ count: 3 }),
    }),
    defineTool({
        name: "crash",
        anyOf: ["knowledge:read"],
        title: "Crash",
        description: "Fails.",
        annotations: { readOnlyHint: true },
        input: {},
        output: { ok: z.boolean() },
        run: async () => {
            throw new Error(SECRET);
        },
    }),
);

const TOKENS: Record<string, McpTokenClaims> = {
    alice: {
        sub: "alice-sub",
        azp: "claude",
        resource_access: { "riffado-mcp": { roles: ["knowledge:read"] } },
    },
    "alice-no-roles": {
        sub: "alice-sub",
        azp: "claude",
        resource_access: { "riffado-mcp": { roles: ["admin"] } },
    },
    stranger: {
        sub: "stranger-sub",
        azp: "cursor",
        resource_access: { "riffado-mcp": { roles: ["knowledge:read"] } },
    },
    bot: {
        sub: "sa-uuid",
        azp: "intranet-bot",
        client_id: "intranet-bot",
        resource_access: { "riffado-mcp": { roles: ["tasks:read"] } },
    },
    "alice-code": {
        sub: "alice-sub",
        azp: "claude-code",
        resource_access: { "riffado-mcp": { roles: ["knowledge:read"] } },
    },
};

/** Genuine tokens of the realm issued for another audience. */
const FOREIGN: Record<string, McpTokenClaims> = {
    "alice-elsewhere": { sub: "alice-sub", azp: "claude" },
};

async function checkToken(token: string): Promise<McpTokenCheck> {
    const valid = TOKENS[token];
    if (valid) return { kind: "valid", claims: valid };
    const foreign = FOREIGN[token];
    if (foreign) return { kind: "other-audience", claims: foreign };
    return { kind: "invalid" };
}

function post(
    body: unknown,
    options: { token?: string | null; headers?: Record<string, string> } = {},
): Request {
    const token = options.token === undefined ? "alice" : options.token;
    return new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-real-ip": IP,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...options.headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

function bare(method: string, host = "localhost"): Request {
    return new Request(`http://${host}/api/mcp`, {
        method,
        headers: { host },
    });
}

const call = (
    id: number,
    name: string,
    args: Record<string, unknown> = {},
) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
});

describeWithDatabase("POST /api/mcp (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    function auditRows() {
        return db().select().from(mcpAccessLog).orderBy(asc(mcpAccessLog.at));
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_route",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        for (const key of Object.keys(mockEnv)) delete mockEnv[key];
        Object.assign(mockEnv, baseEnv, {
            MCP_ALLOWED_CLIENTS: [],
            MCP_PUBLIC_CLIENTS: [],
            MCP_CONNECTOR_KEYS: [],
        });
        verify.mockReset().mockImplementation(checkToken);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await db().delete(mcpAccessLog);
        await db().delete(apiRateLimitBuckets);
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: ALICE, email: "alice@example.test" });
        await db().insert(accounts).values({
            userId: ALICE,
            providerId: "oidc",
            accountId: "alice-sub",
        });
        await ensureOrgAccount();
    });

    afterEach(() => {
        vi.mocked(console.warn).mockRestore();
    });

    it("is not there while MCP is off", async () => {
        mockEnv.MCP_AUDIENCE = undefined;
        expect((await POST(post({}))).status).toBe(404);
        expect((await GET(bare("GET"))).status).toBe(404);
        expect((await DELETE(bare("DELETE"))).status).toBe(404);
        expect(verify).not.toHaveBeenCalled();
    });

    it("is not there on the admin hostname", async () => {
        mockEnv.ADMIN_HOSTNAME = "admin.example.test";
        const response = await POST(
            post(
                { jsonrpc: "2.0", id: 1, method: "tools/list" },
                { headers: { host: "admin.example.test" } },
            ),
        );
        expect(response.status).toBe(404);
        expect(verify).not.toHaveBeenCalled();
        for (const method of ["GET", "DELETE"] as const) {
            const handler = method === "GET" ? GET : DELETE;
            expect(
                (await handler(bare(method, "admin.example.test"))).status,
            ).toBe(404);
        }
        const elsewhere = await POST(
            post(
                { jsonrpc: "2.0", id: 1, method: "tools/list" },
                { headers: { host: "riffado.example.com" } },
            ),
        );
        expect(elsewhere.status).toBe(200);
    });

    it("answers 401 with the metadata pointer and scope without a token", async () => {
        const response = await POST(post({}, { token: null }));
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe(
            `Bearer ${CHALLENGE}`,
        );
        expect(verify).not.toHaveBeenCalled();
    });

    it("answers 401 invalid_token for a token it does not accept", async () => {
        const response = await POST(post({}, { token: "forged" }));
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe(
            `Bearer error="invalid_token", ${CHALLENGE}`,
        );
        await expect(response.json()).resolves.toEqual({
            error: "Unauthorized",
        });
        expect(await auditRows()).toEqual([]);
    });

    it("answers 403, not 401, for a genuine token issued for another audience", async () => {
        const response = await POST(
            post(
                { jsonrpc: "2.0", id: 1, method: "tools/list" },
                {
                    token: "alice-elsewhere",
                },
            ),
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("WWW-Authenticate")).toBeNull();
        await expect(response.json()).resolves.toEqual({
            error: "This token carries no Riffado MCP role",
        });
        expect(await auditRows()).toEqual([
            expect.objectContaining({
                callerKind: null,
                subject: "alice-sub",
                clientId: "claude",
                tool: null,
                outcome: "denied",
            }),
        ]);
    });

    it("takes the bearer scheme in any case", async () => {
        for (const header of [
            "bearer alice",
            "BEARER alice",
            "Bearer  alice ",
        ]) {
            const response = await POST(
                post(
                    { jsonrpc: "2.0", id: 1, method: "tools/list" },
                    { token: null, headers: { authorization: header } },
                ),
            );
            expect(response.status).toBe(200);
        }
        expect(verify).toHaveBeenCalledWith("alice");
        for (const header of ["Basic alice", "Bearer", "Bearer alice bob"]) {
            const response = await POST(
                post({}, { token: null, headers: { authorization: header } }),
            );
            expect(response.status).toBe(401);
        }
    });

    it("answers 503 while the realm cannot be reached", async () => {
        verify.mockRejectedValue(new Error("discovery 502"));
        const response = await POST(post({}));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            error: "Identity provider unavailable",
        });
    });

    it("tells a valid stranger to sign in once, and logs the refusal", async () => {
        const response = await POST(post({}, { token: "stranger" }));
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
            error: "Sign in to Riffado once first",
        });
        expect(await auditRows()).toEqual([
            expect.objectContaining({
                callerKind: null,
                userId: null,
                subject: "stranger-sub",
                clientId: "cursor",
                tool: null,
                outcome: "denied",
                ip: IP,
            }),
        ]);
    });

    it("names a missing role, and says only Forbidden for any other refusal", async () => {
        const noRoles = await POST(post({}, { token: "alice-no-roles" }));
        expect(noRoles.status).toBe(403);
        await expect(noRoles.json()).resolves.toEqual({
            error: "This token carries no Riffado MCP role",
        });

        mockEnv.MCP_ALLOWED_CLIENTS = ["intranet-bot"];
        const notAllowed = await POST(post({}, { token: "alice" }));
        expect(notAllowed.status).toBe(403);
        await expect(notAllowed.json()).resolves.toEqual({
            error: "Forbidden",
        });

        const rows = await auditRows();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row).toMatchObject({
                subject: "alice-sub",
                clientId: "claude",
                outcome: "denied",
            });
        }
    });

    it("charges a refused caller's budget before logging the refusal", async () => {
        for (let n = 0; n < MCP_CALLER_LIMIT; n++) {
            const refused = await POST(post({}, { token: "stranger" }));
            expect(refused.status).toBe(403);
        }
        const limited = await POST(post({}, { token: "stranger" }));
        expect(limited.status).toBe(429);
        expect(await auditRows()).toHaveLength(MCP_CALLER_LIMIT);
    });

    it("charges an admitted caller once per request", async () => {
        const response = await POST(
            post(call(3, "note_lookup", { name: "Orion" })),
        );
        expect(response.status).toBe(200);
        const buckets = await db().select().from(apiRateLimitBuckets);
        expect(buckets.map((bucket) => bucket.count)).toEqual([1]);
    });

    it("keeps no per-IP budget: one address carries many callers", async () => {
        const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
        for (const token of ["alice", "bot"]) {
            for (let n = 0; n < MCP_CALLER_LIMIT; n++) {
                expect((await POST(post(list, { token }))).status).toBe(200);
            }
        }
        const third = await POST(post(list, { token: "alice-code" }));
        expect(third.status).toBe(200);
    });

    describe("through the public entrance", () => {
        beforeEach(() => {
            mockEnv.MCP_PUBLIC_INGRESS_HEADER = "x-mcp-ingress";
            mockEnv.MCP_PUBLIC_CLIENTS = ["claude"];
        });

        const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

        it("serves a public client", async () => {
            const response = await POST(post(list, { headers: PUBLIC }));
            expect(response.status).toBe(200);
        });

        it("refuses Claude Code's and a service account's tokens, and logs it", async () => {
            for (const token of ["alice-code", "bot"]) {
                const response = await POST(
                    post(list, { token, headers: PUBLIC }),
                );
                expect(response.status).toBe(403);
                await expect(response.json()).resolves.toEqual({
                    error: "Forbidden",
                });
            }
            const rows = await auditRows();
            expect(
                rows.map((row) => [row.clientId, row.outcome, row.tool]),
            ).toEqual([
                ["claude-code", "denied", null],
                ["intranet-bot", "denied", null],
            ]);
            expect(console.warn).toHaveBeenCalledWith(
                "[mcp] refused (client-not-public) a token of client claude-code",
            );
        });

        it("serves Claude Code inside", async () => {
            const response = await POST(post(list, { token: "alice-code" }));
            expect(response.status).toBe(200);
        });

        it("still challenges a request without a token", async () => {
            const response = await POST(
                post({}, { token: null, headers: PUBLIC }),
            );
            expect(response.status).toBe(401);
            expect(response.headers.get("WWW-Authenticate")).toBe(
                `Bearer ${CHALLENGE}`,
            );
        });
    });

    describe("with a connector key", () => {
        beforeEach(() => {
            mockEnv.MCP_CONNECTOR_KEYS = [
                { client: "claude", key: CONNECTOR_KEY },
            ];
        });

        const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

        it("serves the keyed client with its key", async () => {
            const response = await POST(
                post(list, { headers: { "x-api-key": CONNECTOR_KEY } }),
            );
            expect(response.status).toBe(200);
        });

        it("refuses the keyed client without its key, and logs it", async () => {
            const attempts: Record<string, string>[] = [
                {},
                { "x-api-key": "wrong" },
            ];
            for (const headers of attempts) {
                const response = await POST(post(list, { headers }));
                expect(response.status).toBe(403);
                await expect(response.json()).resolves.toEqual({
                    error: "Forbidden",
                });
            }
            expect(await auditRows()).toEqual([
                expect.objectContaining({
                    clientId: "claude",
                    outcome: "denied",
                }),
                expect.objectContaining({
                    clientId: "claude",
                    outcome: "denied",
                }),
            ]);
        });

        it("still challenges a request without a token", async () => {
            const response = await POST(post({}, { token: null }));
            expect(response.status).toBe(401);
        });

        it("leaves other clients alone", async () => {
            const response = await POST(post(list, { token: "alice-code" }));
            expect(response.status).toBe(200);
        });
    });

    it("initializes with a complete JSON response", async () => {
        const response = await POST(
            post({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                },
            }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
            "application/json",
        );
        expect(response.headers.get("mcp-session-id")).toBeNull();
        const body = await response.json();
        expect(body).toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            result: {
                protocolVersion: "2025-06-18",
                serverInfo: { name: "riffado" },
                capabilities: { tools: {} },
            },
        });
    });

    it("acknowledges a notification with 202", async () => {
        const response = await POST(
            post({ jsonrpc: "2.0", method: "notifications/initialized" }),
        );
        expect(response.status).toBe(202);
    });

    it("lists the caller's tools without a prior initialize", async () => {
        const response = await POST(
            post(
                { jsonrpc: "2.0", id: 2, method: "tools/list" },
                { headers: { "mcp-protocol-version": "2025-06-18" } },
            ),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(
            body.result.tools.map((tool: { name: string }) => tool.name),
        ).toEqual(["note_lookup", "crash"]);
    });

    it("lists a service caller's tools by its own roles", async () => {
        const response = await POST(
            post(
                { jsonrpc: "2.0", id: 2, method: "tools/list" },
                { token: "bot" },
            ),
        );
        const body = await response.json();
        expect(
            body.result.tools.map((tool: { name: string }) => tool.name),
        ).toEqual(["task_peek"]);
    });

    it("runs a call and logs it once with what it touched", async () => {
        const response = await POST(
            post(call(3, "note_lookup", { name: "Orion" })),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.result.structuredContent).toEqual({
            id: "ent-1",
            name: "Orion",
        });
        expect(body.result.isError).toBeUndefined();
        expect(await auditRows()).toEqual([
            expect.objectContaining({
                callerKind: "user",
                userId: ALICE,
                subject: "alice-sub",
                clientId: "claude",
                tool: "note_lookup",
                outcome: "ok",
                targetIds: ["ent-1"],
                ip: IP,
            }),
        ]);
    });

    it("logs a service caller's call without a user", async () => {
        const response = await POST(
            post(call(4, "task_peek"), { token: "bot" }),
        );
        const body = await response.json();
        expect(body.result.structuredContent).toEqual({ count: 3 });
        expect(await auditRows()).toEqual([
            expect.objectContaining({
                callerKind: "service",
                userId: null,
                subject: "sa-uuid",
                clientId: "intranet-bot",
                tool: "task_peek",
                outcome: "ok",
            }),
        ]);
    });

    it("answers a tool outside the caller's roles as unknown", async () => {
        const hidden = await (await POST(post(call(5, "task_peek")))).json();
        const missing = await (
            await POST(post(call(5, "no_such_tool")))
        ).json();
        expect(hidden).toEqual(missing);
        expect(hidden.result).toEqual({
            content: [{ type: "text", text: '{"error":"Unknown tool"}' }],
            isError: true,
        });
        const rows = await auditRows();
        expect(rows.map((row) => [row.tool, row.outcome])).toEqual([
            ["task_peek", "denied"],
            [null, "invalid"],
        ]);
    });

    it("never lets an unexpected failure reach the client", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const response = await POST(post(call(6, "crash")));
        const text = await response.text();
        expect(text).not.toContain(SECRET);
        expect(JSON.parse(text).result).toEqual({
            content: [{ type: "text", text: '{"error":"Internal error"}' }],
            isError: true,
        });
        expect(await auditRows()).toEqual([
            expect.objectContaining({ tool: "crash", outcome: "error" }),
        ]);
        error.mockRestore();
    });

    it("refuses a batch without running any of it", async () => {
        const response = await POST(
            post([
                { jsonrpc: "2.0", id: 7, method: "tools/list" },
                call(8, "note_lookup", { name: "Vega" }),
            ]),
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            jsonrpc: "2.0",
            error: {
                code: -32600,
                message: "Batch requests are not supported",
            },
            id: null,
        });
        expect(await auditRows()).toEqual([]);
    });

    it("refuses a body over the limit", async () => {
        const big = JSON.stringify({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/list",
            params: { pad: "x".repeat(MCP_MAX_BODY_BYTES) },
        });
        const response = await POST(post(big));
        expect(response.status).toBe(413);
    });

    it("refuses a body that is not JSON", async () => {
        const response = await POST(post("{not json"));
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            jsonrpc: "2.0",
            error: { code: -32700 },
            id: null,
        });
    });

    it("rejects GET and DELETE", async () => {
        for (const response of [
            await GET(bare("GET")),
            await DELETE(bare("DELETE")),
        ]) {
            expect(response.status).toBe(405);
            expect(response.headers.get("Allow")).toBe("POST");
        }
    });
});
