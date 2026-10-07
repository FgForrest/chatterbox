/**
 * The external MCP endpoint against a real Keycloak: tokens come from the
 * e2e realm over HTTP and are verified by the real `verifyMcpToken` against
 * the realm's discovery document and signing keys.
 *
 * - `riffado-mcp-tester` (public, password grant, test only) scope-maps just
 *   `knowledge:read` and `transcripts:read`, so Alice's other roles never
 *   reach the token: narrowing happens in Keycloak.
 * - `riffado-mcp-bot` is a service account acting as the Organization.
 *
 * Opt-in. Needs `TEST_DATABASE_URL` (see the other integration tests) and
 * `KEYCLOAK_TEST_ISSUER`, the realm of `docker-compose.e2e.sso.yml`:
 *
 *   docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.sso.yml up -d --wait keycloak
 *   KEYCLOAK_TEST_ISSUER=http://localhost:8180/realms/riffado-e2e \
 *   TEST_DATABASE_URL=... vitest run src/tests/mcp/keycloak.integration.test.ts
 *
 * Keycloak's issuer is its KC_HOSTNAME, so start it with the URL this test
 * reaches it at.
 */

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
const TASK_TOOLS = ["list_tasks", "search_tasks", "update_task"];

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

function post(token: string, body: unknown): Request {
    return new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-real-ip": "203.0.113.7",
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
