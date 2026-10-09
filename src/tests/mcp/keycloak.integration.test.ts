/**
 * The external MCP endpoint against a real Keycloak: tokens come from the
 * e2e realm over HTTP and are verified by the real `verifyMcpToken` against
 * the realm's discovery document and signing keys.
 *
 * - `riffado-mcp-tester` (public, password grant, test only) scope-maps just
 *   `knowledge:read` and `transcripts:read`, so Alice's other roles never
 *   reach the token: narrowing happens in Keycloak.
 * - `riffado-mcp-bot` is a service account acting as the Organization.
 * - `claude` (confidential) and `claude-code` (public) sign people in the
 *   way Claude does: authorization code with PKCE, `openid offline_access`,
 *   `resource` naming the MCP endpoint, then refresh.
 *
 * Opt-in. Needs `TEST_DATABASE_URL` (see the other integration tests) and
 * `KEYCLOAK_TEST_ISSUER`, the realm of `docker-compose.e2e.sso.yml`:
 *
 *   docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.sso.yml up -d --wait keycloak
 *   KEYCLOAK_TEST_ISSUER=http://localhost:8180/realms/riffado-e2e \
 *   TEST_DATABASE_URL=... vitest run src/tests/mcp/keycloak.integration.test.ts
 *
 * Keycloak's issuer is its KC_HOSTNAME, so start it with the URL this test
 * reaches it at. With `docker-compose.e2e.sso-resource-indicators.yml` added,
 * set `KEYCLOAK_TEST_RESOURCE_INDICATORS=true` as well. The admin password
 * (`KEYCLOAK_TEST_ADMIN_PASSWORD`, default `admin`) lets the test take a role
 * away and give it back.
 */

import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, users } from "@/db/schema";
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
            APP_URL: "https://riffado.example.com",
            RATE_LIMIT_TRUST_PROXY_HEADERS: true,
            OIDC_ISSUER_URL: process.env.KEYCLOAK_TEST_ISSUER?.replace(
                /\/+$/,
                "",
            ),
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "riffado-e2e-client-secret",
            MCP_AUDIENCE: "riffado-mcp",
            MCP_ALLOWED_CLIENTS: [] as string[],
            MCP_PUBLIC_INGRESS_HEADER: "x-mcp-ingress",
            MCP_PUBLIC_CLIENTS: ["claude"],
            MCP_CONNECTOR_KEYS: [] as { client: string; key: string }[],
            MCP_RESOURCE_AUDIENCE:
                process.env.KEYCLOAK_TEST_RESOURCE_INDICATORS === "true",
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

import { POST } from "@/app/api/mcp/route";
import { ensureRootFolders } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";
import { insertRecording, shareRecording } from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && mockEnv.OIDC_ISSUER_URL ? describe : describe.skip;

const ALICE = "user-alice";

const RESOURCE_INDICATORS = mockEnv.MCP_RESOURCE_AUDIENCE;
const RESOURCE = "https://riffado.example.com/api/mcp";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_SECRET = "claude-e2e-client-secret";
const PUBLIC = { "x-mcp-ingress": "public" };

const KNOWLEDGE_TOOLS = [
    "list_types",
    "list_knowledge",
    "find_knowledge",
    "get_entity",
    "get_facts",
    "list_mishearings",
];
const RECORDING_TOOLS = ["list_folders", "list_recordings"];
const TRANSCRIPT_TOOLS = ["get_transcript", "search_transcripts"];
const SUMMARY_TOOLS = ["get_summary", "search_summaries"];
const TASK_READ_TOOLS = ["list_tasks", "search_tasks"];
const TASK_TOOLS = [...TASK_READ_TOOLS, "update_task"];
const ALICE_TOOLS = [
    ...KNOWLEDGE_TOOLS,
    ...RECORDING_TOOLS,
    ...TRANSCRIPT_TOOLS,
    ...SUMMARY_TOOLS,
    ...TASK_READ_TOOLS,
].sort();

/** A token from the realm's token endpoint. */
async function realmToken(form: Record<string, string>): Promise<string> {
    const response = await fetch(
        `${mockEnv.OIDC_ISSUER_URL}/protocol/openid-connect/token`,
        {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form),
        },
    );
    const body = (await response.json()) as {
        access_token?: string;
        error_description?: string;
    };
    if (!response.ok || !body.access_token) {
        throw new Error(
            `token request failed: ${response.status} ${body.error_description ?? ""}`,
        );
    }
    return body.access_token;
}

/** The same token with one character of its signature changed. */
function tampered(token: string): string {
    const [header, payload, signature = ""] = token.split(".");
    const index = Math.floor(signature.length / 2);
    const flipped = signature[index] === "A" ? "B" : "A";
    return [
        header,
        payload,
        `${signature.slice(0, index)}${flipped}${signature.slice(index + 1)}`,
    ].join(".");
}

function post(
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
): Request {
    return new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-real-ip": "203.0.113.7",
            authorization: `Bearer ${token}`,
            ...headers,
        },
        body: JSON.stringify(body),
    });
}

function listTools(token: string, headers?: Record<string, string>) {
    return POST(
        post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers),
    );
}

async function toolNames(
    token: string,
    headers?: Record<string, string>,
): Promise<string[]> {
    const response = await listTools(token, headers);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
        result: { tools: { name: string }[] };
    };
    return body.result.tools.map((tool) => tool.name).sort();
}

interface RecordingsOut {
    recordings: { id: string; view: string; owner_is_me: boolean }[];
}

async function listRecordings(token: string): Promise<RecordingsOut> {
    const response = await POST(
        post(token, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "list_recordings", arguments: {} },
        }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
        result: { isError?: boolean; structuredContent: RecordingsOut };
    };
    expect(body.result.isError).toBeUndefined();
    return body.result.structuredContent;
}

describeWithKeycloak("MCP with Keycloak", () => {
    let database: TestPostgresDatabase | null = null;
    let aliceToken = "";
    let botToken = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_keycloak",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;

        aliceToken = await realmToken({
            grant_type: "password",
            client_id: "riffado-mcp-tester",
            username: "alice",
            password: "alice-password",
            scope: "openid",
        });
        botToken = await realmToken({
            grant_type: "client_credentials",
            client_id: "riffado-mcp-bot",
            client_secret: "riffado-mcp-bot-secret",
        });

        const aliceSub = decodeJwt(aliceToken).sub;
        if (!aliceSub) throw new Error("Alice's token has no sub");
        await db()
            .insert(users)
            .values({ id: ALICE, email: "alice@example.com" });
        await db().insert(accounts).values({
            userId: ALICE,
            providerId: SSO_PROVIDER_ID,
            accountId: aliceSub,
        });
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("organization account missing");
        await ensureRootFolders(ALICE);

        await insertRecording(db(), {
            id: "alice-private",
            userId: ALICE,
            title: "Private call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "alice-shared",
            userId: ALICE,
            title: "Launch review",
            startTime: new Date("2026-09-06T10:00:00Z"),
        });
        await shareRecording(db(), "alice-shared", orgUserId);
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("issues tokens for the MCP audience with the client's roles", () => {
        const alice = decodeJwt(aliceToken);
        expect(alice).toMatchObject({
            iss: mockEnv.OIDC_ISSUER_URL,
            typ: "Bearer",
            azp: "riffado-mcp-tester",
        });
        expect([alice.aud].flat()).toContain("riffado-mcp");
        expect(alice.client_id).toBeUndefined();

        const bot = decodeJwt(botToken);
        expect(bot).toMatchObject({
            iss: mockEnv.OIDC_ISSUER_URL,
            typ: "Bearer",
            azp: "riffado-mcp-bot",
            client_id: "riffado-mcp-bot",
        });
        expect([bot.aud].flat()).toContain("riffado-mcp");
    });

    it("lists only what the tester client lets through of Alice's roles", async () => {
        expect(await toolNames(aliceToken)).toEqual(
            [
                ...KNOWLEDGE_TOOLS,
                ...RECORDING_TOOLS,
                ...TRANSCRIPT_TOOLS,
            ].sort(),
        );
    });

    it("shows Alice all her own recordings, shared or not", async () => {
        const { recordings } = await listRecordings(aliceToken);
        expect(
            recordings.map(({ id, view, owner_is_me }) => ({
                id,
                view,
                owner_is_me,
            })),
        ).toEqual([
            { id: "alice-shared", view: "private", owner_is_me: true },
            { id: "alice-private", view: "private", owner_is_me: true },
        ]);
    });

    it("lists the bot's knowledge, task and recording tools", async () => {
        expect(await toolNames(botToken)).toEqual(
            [...KNOWLEDGE_TOOLS, ...RECORDING_TOOLS, ...TASK_TOOLS].sort(),
        );
    });

    it("shows the bot only what the Organization shares", async () => {
        const { recordings } = await listRecordings(botToken);
        expect(
            recordings.map(({ id, view, owner_is_me }) => ({
                id,
                view,
                owner_is_me,
            })),
        ).toEqual([{ id: "alice-shared", view: "org", owner_is_me: false }]);
    });

    it("refuses a client outside MCP_ALLOWED_CLIENTS", async () => {
        mockEnv.MCP_ALLOWED_CLIENTS = ["riffado-mcp-bot"];
        try {
            const refused = await POST(
                post(aliceToken, {
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/list",
                }),
            );
            expect(refused.status).toBe(403);
            await expect(refused.json()).resolves.toEqual({
                error: "Forbidden",
            });
            expect(await toolNames(botToken)).toContain("list_tasks");
        } finally {
            mockEnv.MCP_ALLOWED_CLIENTS = [];
        }
    });

    it("rejects a token whose signature was changed", async () => {
        const response = await POST(
            post(tampered(aliceToken), {
                jsonrpc: "2.0",
                id: 4,
                method: "tools/list",
            }),
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toContain(
            "resource_metadata=",
        );
    });
});

interface SignIn {
    clientId: string;
    username: string;
    redirectUri: string;
    resource?: string;
}

interface TokenResponse {
    status: number;
    error?: string;
    access_token?: string;
    refresh_token?: string;
}

/** The parameters Claude sends on the authorization request. */
async function authorize({
    clientId,
    username,
    redirectUri,
    resource,
}: SignIn): Promise<{ code: string; verifier: string }> {
    const issuer = mockEnv.OIDC_ISSUER_URL ?? "";
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "openid offline_access",
        state: randomBytes(8).toString("hex"),
        code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
        code_challenge_method: "S256",
        ...(resource ? { resource } : {}),
    }).toString();

    const page = await fetch(url, { redirect: "manual" });
    expect(page.status).toBe(200);
    const cookies = page.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    const html = await page.text();
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/
        .exec(html)?.[1]
        ?.replaceAll("&amp;", "&");
    if (!action) throw new Error("no login form");

    const login = await fetch(action, {
        method: "POST",
        redirect: "manual",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookies,
        },
        body: new URLSearchParams({
            username,
            password: `${username}-password`,
            credentialId: "",
        }),
    });
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
        new URL(redirectUri).href,
    );
    const code = location.searchParams.get("code");
    if (!code) throw new Error(`no code: ${location.search}`);
    return { code, verifier };
}

async function tokenRequest(
    form: Record<string, string>,
    secret?: string,
): Promise<TokenResponse> {
    const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
    };
    if (secret) {
        headers.authorization = `Basic ${Buffer.from(
            `${form.client_id}:${secret}`,
        ).toString("base64")}`;
    }
    const response = await fetch(
        `${mockEnv.OIDC_ISSUER_URL}/protocol/openid-connect/token`,
        { method: "POST", headers, body: new URLSearchParams(form) },
    );
    return { status: response.status, ...(await response.json()) };
}

/** Sign in as Claude does, and redeem the code with `secret`. */
async function signIn(
    request: SignIn,
    secret?: string,
): Promise<TokenResponse> {
    const { code, verifier } = await authorize(request);
    return tokenRequest(
        {
            grant_type: "authorization_code",
            code,
            redirect_uri: request.redirectUri,
            code_verifier: verifier,
            client_id: request.clientId,
            ...(request.resource ? { resource: request.resource } : {}),
        },
        secret,
    );
}

function refresh(refreshToken: string): Promise<TokenResponse> {
    return tokenRequest(
        {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: "claude",
            resource: RESOURCE,
        },
        CLAUDE_SECRET,
    );
}

function claude(username: string, resource = RESOURCE): SignIn {
    return {
        clientId: "claude",
        username,
        redirectUri: CLAUDE_REDIRECT,
        resource,
    };
}

/** Take one of Alice's MCP roles away in the realm; returns the undo. */
async function revokeRole(role: string): Promise<() => Promise<void>> {
    const issuer = new URL(mockEnv.OIDC_ISSUER_URL ?? "");
    const realm = issuer.pathname.split("/").pop() ?? "";
    const login = await fetch(
        `${issuer.origin}/realms/master/protocol/openid-connect/token`,
        {
            method: "POST",
            body: new URLSearchParams({
                grant_type: "password",
                client_id: "admin-cli",
                username: "admin",
                password: process.env.KEYCLOAK_TEST_ADMIN_PASSWORD ?? "admin",
            }),
        },
    );
    const { access_token: adminToken } = (await login.json()) as {
        access_token: string;
    };
    const admin = `${issuer.origin}/admin/realms/${realm}`;
    const headers = {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
    };
    const get = async <T>(path: string): Promise<T> =>
        (await fetch(`${admin}${path}`, { headers })).json() as Promise<T>;
    const [client] = await get<{ id: string }[]>(
        "/clients?clientId=riffado-mcp",
    );
    const [user] = await get<{ id: string }[]>(
        "/users?username=alice&exact=true",
    );
    if (!client || !user) throw new Error("realm lacks riffado-mcp or alice");
    const representation = await get<unknown>(
        `/clients/${client.id}/roles/${encodeURIComponent(role)}`,
    );
    const mappings = `${admin}/users/${user.id}/role-mappings/clients/${client.id}`;
    const change = async (method: "DELETE" | "POST") => {
        const response = await fetch(mappings, {
            method,
            headers,
            body: JSON.stringify([representation]),
        });
        expect(response.status).toBe(204);
    };
    await change("DELETE");
    return () => change("POST");
}

describeWithKeycloak("Claude's sign-in against Keycloak", () => {
    let database: TestPostgresDatabase | null = null;
    let alice: TokenResponse = { status: 0 };

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_claude",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;

        alice = await signIn(claude("alice"), CLAUDE_SECRET);
        const aliceSub = decodeJwt(alice.access_token ?? "").sub;
        if (!aliceSub) throw new Error("Alice's token has no sub");
        await db()
            .insert(users)
            .values({ id: ALICE, email: "alice@example.com" });
        await db().insert(accounts).values({
            userId: ALICE,
            providerId: SSO_PROVIDER_ID,
            accountId: aliceSub,
        });
        await ensureOrgAccount();
        await ensureRootFolders(ALICE);
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("issues the hosted client a token for Riffado alone, with Alice's roles", () => {
        expect(alice.status).toBe(200);
        const token = decodeJwt(alice.access_token ?? "");
        expect(token).toMatchObject({
            iss: mockEnv.OIDC_ISSUER_URL,
            typ: "Bearer",
            azp: "claude",
            scope: "openid offline_access",
        });
        expect([token.aud].flat()).toEqual([
            RESOURCE_INDICATORS ? RESOURCE : "riffado-mcp",
        ]);
        expect(
            (token.resource_access as Record<string, { roles: string[] }>)[
                "riffado-mcp"
            ]?.roles.sort(),
        ).toEqual([
            "knowledge:read",
            "summaries:read",
            "tasks:read",
            "transcripts:read",
        ]);
        expect(Number(token.exp) - Number(token.iat)).toBe(900);
        expect(decodeJwt(alice.refresh_token ?? "").typ).toBe("Offline");
    });

    it("serves the hosted client through the public entrance", async () => {
        expect(await toolNames(alice.access_token ?? "", PUBLIC)).toEqual(
            ALICE_TOOLS,
        );
    });

    it("redeems the hosted client's code only with its secret", async () => {
        for (const secret of [undefined, "wrong-secret"]) {
            const refused = await signIn(claude("alice"), secret);
            expect(refused).toMatchObject({
                status: 401,
                error: "unauthorized_client",
            });
            expect(refused.access_token).toBeUndefined();
        }
    });

    it("refuses a token for another server's URL only with resource indicators", async () => {
        const foreign = await signIn(
            claude("alice", "https://attacker.example/mcp"),
            CLAUDE_SECRET,
        );
        if (RESOURCE_INDICATORS) {
            expect(foreign).toMatchObject({
                status: 400,
                error: "invalid_target",
            });
        } else {
            expect(foreign.status).toBe(200);
            expect([decodeJwt(foreign.access_token ?? "").aud].flat()).toEqual([
                "riffado-mcp",
            ]);
        }
    });

    it("keeps serving after a refresh, and drops a role taken away in the realm", async () => {
        const first = await refresh(alice.refresh_token ?? "");
        expect(first.status).toBe(200);
        expect(await toolNames(first.access_token ?? "", PUBLIC)).toEqual(
            ALICE_TOOLS,
        );

        const restore = await revokeRole("summaries:read");
        try {
            const second = await refresh(first.refresh_token ?? "");
            expect(second.status).toBe(200);
            expect(await toolNames(second.access_token ?? "", PUBLIC)).toEqual(
                ALICE_TOOLS.filter((tool) => !SUMMARY_TOOLS.includes(tool)),
            );
        } finally {
            await restore();
        }
    });

    it.skipIf(RESOURCE_INDICATORS)(
        "answers 403, not 401, to a person without any MCP role",
        async () => {
            const bob = await signIn(claude("bob"), CLAUDE_SECRET);
            expect(bob.status).toBe(200);
            const token = decodeJwt(bob.access_token ?? "");
            expect(token.azp).toBe("claude");
            expect([token.aud ?? []].flat()).not.toContain("riffado-mcp");
            const response = await listTools(bob.access_token ?? "", PUBLIC);
            expect(response.status).toBe(403);
            await expect(response.json()).resolves.toEqual({
                error: "This token carries no Riffado MCP role",
            });
        },
    );

    it("signs Claude Code in on any loopback port, and serves it inside only", async () => {
        for (const redirectUri of [
            "http://127.0.0.1:53127/callback",
            "http://localhost:41999/callback",
        ]) {
            const code = await signIn({
                clientId: "claude-code",
                username: "alice",
                redirectUri,
                resource: RESOURCE,
            });
            expect(code.status).toBe(200);
            const token = code.access_token ?? "";
            expect(decodeJwt(token).azp).toBe("claude-code");
            expect(await toolNames(token)).toEqual(ALICE_TOOLS);
            const outside = await listTools(token, PUBLIC);
            expect(outside.status).toBe(403);
        }
    });

    it("wants the connector key of the hosted client once it has one", async () => {
        const key = "0123456789abcdef0123456789abcdef";
        mockEnv.MCP_CONNECTOR_KEYS = [{ client: "claude", key }];
        try {
            const token = alice.access_token ?? "";
            expect((await listTools(token, PUBLIC)).status).toBe(403);
            expect(
                await toolNames(token, { ...PUBLIC, "x-api-key": key }),
            ).toEqual(ALICE_TOOLS);
        } finally {
            mockEnv.MCP_CONNECTOR_KEYS = [];
        }
    });
});
