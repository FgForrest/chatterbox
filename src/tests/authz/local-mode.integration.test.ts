/**
 * Without identity-provider authorization (AUTHZ_MODE=local, the default)
 * nothing about the new authorization takes over: every signed-in account
 * may use the application, the organization account (and only it) acts
 * for the Organization, nobody is an implicit administrator or curator,
 * access management does not exist, and API keys work as before.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiKeys, sessions, users } from "@/db/schema";
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
                if (!current)
                    throw new Error("test database was not initialized");
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
            SELF_HOST_MODE: "shared" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            API_TOKEN_HASH_SECRET: undefined as string | undefined,
            DATABASE_URL: "postgres://unused",
            APP_URL: "http://localhost:3000",
            OIDC_ISSUER_URL: undefined as string | undefined,
            OIDC_CLIENT_ID: undefined as string | undefined,
            OIDC_CLIENT_SECRET: undefined as string | undefined,
            AUTHZ_MODE: "local" as "local" | "idp",
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            AUTHZ_ADMIN_MAX_AUTH_AGE: 8 * 3600,
            MCP_SERVICE_CLIENTS: [] as string[],
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

import { accessManagementAvailable, listAccess } from "@/lib/access/service";
import {
    authenticateRequest,
    createApiKey,
    getApiKeyPrefix,
    hashApiKey,
} from "@/lib/auth-request";
import { actsForOrganization } from "@/lib/authz/curator";
import { sessionAccess } from "@/lib/authz/session-access";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("AUTHZ_MODE=local (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function session(userId: string) {
        const [row] = await db()
            .insert(sessions)
            .values({
                userId,
                token: `token-${userId}-${Math.random()}`,
                expiresAt: new Date(Date.now() + 3600_000),
            })
            .returning({ id: sessions.id });
        return { id: row?.id ?? "", userId };
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "authz_local",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values({ id: "user-ann", email: "ann@example.test" });
        orgUserId = (await ensureOrgAccount()) ?? "";
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("lets every signed-in account use the application, and nothing more", async () => {
        const access = await sessionAccess(await session("user-ann"));
        expect(access.ok).toBe(true);
        if (!access.ok) return;
        expect(access.actor.kind).toBe("user");
        expect([...access.actor.capabilities]).toEqual(["use"]);
        expect(await actsForOrganization(access.actor)).toBe(false);
        expect(accessManagementAvailable(access.actor)).toBe(false);
    });

    it("keeps the organization account the one that acts for the Organization", async () => {
        const access = await sessionAccess(await session(orgUserId));
        expect(access.ok).toBe(true);
        if (!access.ok) return;
        expect(access.actor.kind).toBe("local-org");
        expect(await actsForOrganization(access.actor)).toBe(true);
    });

    it("has no access management", async () => {
        const access = await sessionAccess(await session("user-ann"));
        if (!access.ok) throw new Error("no access");
        await expect(
            listAccess(
                {
                    actor: access.actor,
                    session: { id: "s", userId: "user-ann" },
                    authTime: new Date(),
                },
                { page: 0, pageSize: 20 },
            ),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("authenticates API keys without asking any identity provider", async () => {
        const raw = createApiKey();
        await db()
            .insert(apiKeys)
            .values({
                userId: "user-ann",
                name: "key",
                keyHash: hashApiKey(raw),
                keyPrefix: getApiKeyPrefix(raw),
                scopes: ["recordings:write"],
            });
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const authn = await authenticateRequest(
            new Request("http://localhost/api/v1/recordings", {
                headers: { authorization: `Bearer ${raw}` },
            }),
        );
        expect(authn).toMatchObject({
            user: { id: "user-ann" },
            via: "api-key",
            scopes: ["recordings:write"],
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it("never signs the organization account in interactively under single sign-on", async () => {
        mockEnv.OIDC_ISSUER_URL = "https://id.example.com/realms/acme";
        mockEnv.OIDC_CLIENT_ID = "chatterbox";
        mockEnv.OIDC_CLIENT_SECRET = "secret";
        try {
            const orgSession = await session(orgUserId);
            expect(await sessionAccess(orgSession)).toEqual({
                ok: false,
                reason: "org-account",
            });
            expect(
                await db()
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, orgSession.id)),
            ).toEqual([]);
        } finally {
            mockEnv.OIDC_ISSUER_URL = undefined;
            mockEnv.OIDC_CLIENT_ID = undefined;
            mockEnv.OIDC_CLIENT_SECRET = undefined;
        }
    });
});
