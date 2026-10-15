/**
 * The MCP server with identity-provider authorization, against a realm the
 * test fixture imported and tokens Keycloak issued:
 *
 * - a person is the account linked to their issuer and `sub`, and needs a
 *   verified `use`; a person who never signed in is refused, never taken
 *   for a service;
 * - a service is only a marked token of a configured service-only client,
 *   and sees the Organization's shared data alone;
 * - the web sign-in token and an ID token are never MCP credentials;
 * - a permission taken away hides its tools and refuses a direct call with
 *   `insufficient_scope`; a client asking for the scopes the metadata
 *   lists gets them, and one it may not have is refused by the realm.
 *
 * Opt-in: `TEST_DATABASE_URL` and `KEYCLOAK_TEST_ISSUER`.
 */

import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { userAccessStates, users } from "@/db/schema";
import { adminPath } from "@/lib/identity/providers/keycloak/http";
import { keycloakLogin } from "@/tests/authz/keycloak-login";
import {
    keycloakTestBase,
    provisionTestRealm,
    type TestRealm,
} from "@/tests/identity/keycloak-fixture";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { insertRecording, shareRecording } from "@/tests/mcp/fixtures";

const REALM = "chb-mcp-it";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current)
                    throw new Error("test database was not initialized");
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    const issuer = process.env.KEYCLOAK_TEST_ISSUER
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-mcp-it`
        : undefined;
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            BILLING_ENABLED: undefined as boolean | undefined,
            SELF_HOST_MODE: "shared" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            OIDC_ISSUER_URL: issuer,
            OIDC_CLIENT_ID: "chatterbox",
            OIDC_CLIENT_SECRET: "chatterbox-mcp-it-secret",
            OIDC_PROVIDER_NAME: "Keycloak",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: false,
            APP_URL: "http://localhost:3000",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
            RATE_LIMIT_TRUST_PROXY_HEADERS: true,
            MCP_AUDIENCE: "chatterbox-mcp",
            MCP_ALLOWED_CLIENTS: ["mcp-tester", "claude", "chatterbox-bot"],
            MCP_SERVICE_CLIENTS: ["chatterbox-bot"] as string[],
            MCP_PUBLIC_INGRESS_HEADER: undefined as string | undefined,
            MCP_PUBLIC_CLIENTS: [] as string[],
            MCP_CONNECTOR_KEYS: [] as { client: string; key: string }[],
            MCP_RESOURCE_AUDIENCE: undefined as boolean | undefined,
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier" as
                | string
                | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET: "chatterbox-mcp-it-verifier" as
                | string
                | undefined,
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            AUTHZ_ADMIN_MAX_AUTH_AGE: 8 * 3600,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/hosted/billing/cycle-close", () => ({
    closeCycleForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendEmailChangeConfirm: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendVerifyEmail: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/mcp/route";
import { auth } from "@/lib/auth";
import { ensureRootFolders } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && keycloakTestBase() ? describe : describe.skip;

const KNOWLEDGE_TOOLS = [
    "find_knowledge",
    "get_entity",
    "get_facts",
    "list_knowledge",
    "list_mishearings",
    "list_types",
];
const RECORDING_TOOLS = ["list_folders", "list_recordings"];
const TRANSCRIPT_TOOLS = ["get_transcript", "search_transcripts"];
const TASK_READ_TOOLS = ["list_tasks", "search_tasks"];

function post(token: string, body: unknown): Request {
    return new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-real-ip": "203.0.113.9",
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
}

async function toolNames(token: string): Promise<string[]> {
    const response = await POST(
        post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
        result: { tools: { name: string }[] };
    };
    return body.result.tools.map((tool) => tool.name).sort();
}

function callTool(token: string, name: string, args: object = {}) {
    return POST(
        post(token, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: args },
        }),
    );
}

describeWithKeycloak("MCP with identity-provider authorization", () => {
    let database: TestPostgresDatabase | null = null;
    let realm: TestRealm;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function testerToken(username: string, scope = "openid") {
        const person = realm.people[username];
        if (!person) throw new Error(`no person ${username}`);
        return (await realm.passwordToken("mcp-tester", person, { scope }))
            .access_token;
    }

    async function userId(username: string): Promise<string> {
        const [row] = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, `${username}@example.test`))
            .limit(1);
        if (!row) throw new Error(`no local user ${username}`);
        return row.id;
    }

    beforeAll(async () => {
        realm = await provisionTestRealm(
            "mcp",
            {
                ann: ["use"],
                stranger: ["use"],
                admin: ["use", "access.manage"],
            },
            {
                realmName: REALM,
                secrets: {
                    chatterbox: "chatterbox-mcp-it-secret",
                    "chatterbox-verifier": "chatterbox-mcp-it-verifier",
                },
            },
        );
        mockEnv.KEYCLOAK_GROUP_USE_ID = realm.groupIds.use;
        mockEnv.KEYCLOAK_GROUP_CURATE_ID = realm.groupIds["org.curate"];
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            realm.groupIds["access.manage"];
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_authz",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("organization account missing");
        const person = realm.people.ann;
        if (!person) throw new Error("no ann");
        expect((await keycloakLogin(auth.handler, person)).location).toBe(
            "/dashboard",
        );
        const ann = await userId("ann");
        await ensureRootFolders(ann);
        await insertRecording(db(), {
            id: "ann-private",
            userId: ann,
            title: "Private call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "ann-shared",
            userId: ann,
            title: "Launch review",
            startTime: new Date("2026-09-06T10:00:00Z"),
        });
        await shareRecording(db(), "ann-shared", orgUserId);
    }, 240_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        dbRef.current = null;
        await database?.dispose();
        await realm?.dispose();
    }, 60_000);

    it("serves a signed-in person with use by their linked account", async () => {
        expect(await toolNames(await testerToken("ann"))).toEqual(
            [
                ...KNOWLEDGE_TOOLS,
                ...RECORDING_TOOLS,
                ...TRANSCRIPT_TOOLS,
            ].sort(),
        );
        const response = await callTool(
            await testerToken("ann"),
            "list_recordings",
        );
        const body = (await response.json()) as {
            result: { structuredContent: { recordings: { id: string }[] } };
        };
        expect(
            body.result.structuredContent.recordings.map((r) => r.id).sort(),
        ).toEqual(["ann-private", "ann-shared"]);
    });

    it("refuses a person who never signed in, never treating them as a service", async () => {
        const response = await POST(
            post(await testerToken("stranger"), {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
            error: "Sign in to Chatterbox once first",
        });
    });

    it("serves the marked service client with the Organization's shared data only", async () => {
        const bot = (await realm.clientToken("chatterbox-bot")).access_token;
        expect(await toolNames(bot)).toEqual(
            [...KNOWLEDGE_TOOLS, ...RECORDING_TOOLS, ...TASK_READ_TOOLS].sort(),
        );
        const response = await callTool(bot, "list_recordings");
        const body = (await response.json()) as {
            result: {
                structuredContent: {
                    recordings: { id: string; view: string }[];
                };
            };
        };
        expect(body.result.structuredContent.recordings).toEqual([
            expect.objectContaining({ id: "ann-shared", view: "org" }),
        ]);
        const write = await callTool(bot, "update_task", {});
        expect(write.status).toBe(403);
    });

    it("does not take a client token for a service unless the client is listed", async () => {
        mockEnv.MCP_SERVICE_CLIENTS = [];
        try {
            const bot = (await realm.clientToken("chatterbox-bot"))
                .access_token;
            const response = await POST(
                post(bot, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            );
            expect(response.status).toBe(403);
        } finally {
            mockEnv.MCP_SERVICE_CLIENTS = ["chatterbox-bot"];
        }
    });

    it("never accepts the web sign-in token or an ID token", async () => {
        const web = await realm.passwordToken(
            "chatterbox",
            realm.people.admin ?? (undefined as never),
        );
        expect(
            (
                decodeJwt(web.access_token).resource_access as Record<
                    string,
                    unknown
                >
            )["realm-management"],
        ).toBeDefined();
        const webResponse = await POST(
            post(web.access_token, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(webResponse.status).toBe(403);

        const tester = await realm.passwordToken(
            "mcp-tester",
            realm.people.ann ?? (undefined as never),
        );
        const idResponse = await POST(
            post(tester.id_token ?? "", {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(idResponse.status).toBe(401);
    });

    it("hides a permission taken away and answers a direct call with insufficient_scope", async () => {
        const { http } = realm.admin;
        const [client] = await http.get<{ id: string }[]>(adminPath`/clients`, {
            clientId: "mcp-tester",
        });
        const scopes = await http.get<{ id: string; name: string }[]>(
            adminPath`/clients/${client?.id ?? ""}/default-client-scopes`,
        );
        const transcript = scopes.find(
            (scope) => scope.name === "transcripts:read",
        );
        if (!client || !transcript) throw new Error("Missing tester scope");
        const path = adminPath`/clients/${client.id}/default-client-scopes/${transcript.id}`;
        await http.delete(path);
        try {
            const token = await testerToken("ann");
            expect(await toolNames(token)).not.toContain("get_transcript");
            const response = await callTool(token, "get_transcript", {
                recording_id: "ann-private",
            });
            expect(response.status).toBe(403);
            expect(response.headers.get("WWW-Authenticate")).toContain(
                'error="insufficient_scope", scope="transcripts:read"',
            );
        } finally {
            await http.put(path);
        }
    });

    it("refuses a person whose access was withdrawn, and answers 503 while it cannot be verified", async () => {
        const ann = await userId("ann");
        await db()
            .update(userAccessStates)
            .set({ capabilities: [], source: "access-change" })
            .where(eq(userAccessStates.userId, ann));
        const withdrawn = await POST(
            post(await testerToken("ann"), {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        );
        expect(withdrawn.status).toBe(403);
        expect(await withdrawn.json()).toEqual({
            error: "Your access to Chatterbox has been withdrawn",
        });

        await db()
            .update(userAccessStates)
            .set({ verifiedAt: new Date(Date.now() - 2 * 3600 * 1000) })
            .where(eq(userAccessStates.userId, ann));
        const token = await testerToken("ann");
        const realFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input, init) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.includes("/admin/realms/"))
                    throw new TypeError("fetch failed");
                return realFetch(input, init);
            },
        );
        try {
            const unavailable = await POST(
                post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            );
            expect(unavailable.status).toBe(503);
        } finally {
            vi.restoreAllMocks();
        }
        expect(await toolNames(token)).toContain("list_knowledge");
    });

    it("gives a client the permission scopes the metadata lists, within what it may have", async () => {
        const granted = await testerToken(
            "ann",
            "openid knowledge:read transcripts:read",
        );
        expect(String(decodeJwt(granted).scope).split(" ")).toEqual(
            expect.arrayContaining(["knowledge:read", "transcripts:read"]),
        );
        expect(await toolNames(granted)).toContain("get_transcript");

        await expect(testerToken("ann", "openid tasks:write")).rejects.toThrow(
            /400/,
        );
        expect([decodeJwt(granted).aud ?? []].flat()).toContain(
            "chatterbox-mcp",
        );
    });
});
