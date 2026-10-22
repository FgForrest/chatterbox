/**
 * Who a verified MCP token speaks for, against a real PostgreSQL: an
 * SSO-linked user, a service account acting for the Organization, or nobody.
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
import { accounts, chatterItems, itemShares, users } from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, baseEnv } = vi.hoisted(() => {
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
        OIDC_ISSUER_URL: "https://id.example.com/realms/acme",
        OIDC_CLIENT_ID: "riffado",
        OIDC_CLIENT_SECRET: "secret",
        MCP_AUDIENCE: "riffado-mcp",
        MCP_ALLOWED_CLIENTS: [] as string[],
        MCP_SERVICE_CLIENTS: [] as string[],
    };
    return {
        dbProxy: proxy,
        dbRef: ref,
        baseEnv: base,
        mockEnv: { ...base } as Record<string, unknown>,
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { resolveCaller } from "@/lib/mcp/caller";
import type { McpTokenClaims } from "@/lib/mcp/token";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

function claims(
    sub: string,
    roles: string[],
    extra: Record<string, unknown> = {},
): McpTokenClaims {
    return {
        sub,
        resource_access: { "riffado-mcp": { roles } },
        ...extra,
    };
}

describeWithDatabase("resolveCaller (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId: string | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_caller",
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
            MCP_SERVICE_CLIENTS: [],
        });
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        await db().insert(accounts).values({
            userId: ALICE,
            providerId: "oidc",
            accountId: "alice-sub",
        });
        await db().insert(accounts).values({
            userId: BOB,
            providerId: "credential",
            accountId: "bob-sub",
        });
        orgUserId = await ensureOrgAccount();
    });

    it("resolves an SSO-linked subject to that user", async () => {
        const result = await resolveCaller(
            claims("alice-sub", ["knowledge:read"], { azp: "claude" }),
        );
        expect(result).toEqual({
            ok: true,
            caller: {
                kind: "user",
                userId: ALICE,
                email: "alice@example.test",
                subject: "alice-sub",
                clientId: "claude",
                roles: new Set(["knowledge:read"]),
                receivedItemIds: new Set(),
                orgUserId,
            },
        });
        expect(orgUserId).toBeTruthy();
    });

    it("refuses a token without MCP roles", async () => {
        await expect(
            resolveCaller(claims("alice-sub", ["admin"])),
        ).resolves.toEqual({ ok: false, reason: "no-roles" });
    });

    it("loads only accepted invitations for a linked user's received view", async () => {
        await db()
            .insert(chatterItems)
            .values(
                ["accepted", "pending"].map((state) => ({
                    id: `received-${state}`,
                    userId: BOB,
                    kind: "mail" as const,
                    title: encryptText("Project mail"),
                    occurredAt: new Date(),
                })),
            );
        await db()
            .insert(itemShares)
            .values([
                {
                    userId: BOB,
                    receiverUserId: ALICE,
                    itemId: "received-accepted",
                    state: "accepted",
                },
                {
                    userId: BOB,
                    receiverUserId: ALICE,
                    itemId: "received-pending",
                    state: "pending",
                },
            ]);
        expect(
            await resolveCaller(claims("alice-sub", ["mail:read"])),
        ).toMatchObject({
            ok: true,
            caller: { receivedItemIds: new Set(["received-accepted"]) },
        });
    });

    it("links only through the SSO provider", async () => {
        await expect(
            resolveCaller(claims("bob-sub", ["knowledge:read"])),
        ).resolves.toEqual({ ok: false, reason: "no-account" });
        await expect(
            resolveCaller(claims("unknown", ["knowledge:read"])),
        ).resolves.toEqual({ ok: false, reason: "no-account" });
    });

    it("treats a client's own token as a service caller", async () => {
        const result = await resolveCaller(
            claims("sa-uuid", ["tasks:read"], {
                client_id: "intranet-bot",
                azp: "intranet-bot",
            }),
        );
        expect(result).toEqual({
            ok: true,
            caller: {
                kind: "service",
                subject: "sa-uuid",
                clientId: "intranet-bot",
                roles: new Set(["tasks:read"]),
                orgUserId,
            },
        });
    });

    it("refuses a service caller without the Organization scope", async () => {
        mockEnv.SELF_HOST_MODE = "local";
        await expect(
            resolveCaller(
                claims("sa-uuid", ["tasks:read"], {
                    client_id: "intranet-bot",
                }),
            ),
        ).resolves.toEqual({ ok: false, reason: "no-organization" });
    });

    it("keeps a linked user a user caller without the Organization scope", async () => {
        mockEnv.SELF_HOST_MODE = "local";
        const result = await resolveCaller(
            claims("alice-sub", ["transcripts:read"]),
        );
        expect(result).toMatchObject({
            ok: true,
            caller: { kind: "user", userId: ALICE, orgUserId: null },
        });
    });

    it("admits only allowlisted clients when an allowlist is set", async () => {
        mockEnv.MCP_ALLOWED_CLIENTS = ["claude"];
        await expect(
            resolveCaller(
                claims("alice-sub", ["knowledge:read"], { azp: "cursor" }),
            ),
        ).resolves.toEqual({ ok: false, reason: "client-not-allowed" });
        await expect(
            resolveCaller(claims("alice-sub", ["knowledge:read"])),
        ).resolves.toEqual({ ok: false, reason: "client-not-allowed" });
        await expect(
            resolveCaller(
                claims("alice-sub", ["knowledge:read"], { azp: "claude" }),
            ),
        ).resolves.toMatchObject({ ok: true, caller: { userId: ALICE } });
    });

    it("refuses a suspended user", async () => {
        await db()
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, ALICE));
        await expect(
            resolveCaller(claims("alice-sub", ["knowledge:read"])),
        ).resolves.toEqual({ ok: false, reason: "suspended" });
    });

    it("takes only a marked token of a listed service client for a service once services are listed", async () => {
        mockEnv.MCP_SERVICE_CLIENTS = ["intranet-bot"];
        await expect(
            resolveCaller(
                claims("sa-uuid", ["tasks:read"], {
                    client_id: "intranet-bot",
                    azp: "intranet-bot",
                }),
            ),
        ).resolves.toEqual({ ok: false, reason: "no-account" });
        await expect(
            resolveCaller(
                claims("sa-uuid", ["tasks:read"], {
                    client_id: "other-bot",
                    azp: "other-bot",
                    chatterbox_subject_kind: "service",
                }),
            ),
        ).resolves.toEqual({ ok: false, reason: "no-account" });
        await expect(
            resolveCaller(
                claims("sa-uuid", ["tasks:read"], {
                    client_id: "intranet-bot",
                    azp: "intranet-bot",
                    chatterbox_subject_kind: "service",
                }),
            ),
        ).resolves.toMatchObject({ ok: true, caller: { kind: "service" } });
    });

    it("never takes an unlinked person for a service under identity-provider authorization", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        try {
            await expect(
                resolveCaller(
                    claims("someone", ["tasks:read"], {
                        scope: "openid tasks:read",
                        client_id: "intranet-bot",
                        azp: "intranet-bot",
                    }),
                ),
            ).resolves.toEqual({ ok: false, reason: "no-account" });
        } finally {
            mockEnv.AUTHZ_MODE = undefined;
        }
    });

    it("links a person only through the issuer that vouched for them", async () => {
        await db()
            .update(accounts)
            .set({ issuer: "https://id.example.com/realms/acme" })
            .where(eq(accounts.accountId, "alice-sub"));
        await expect(
            resolveCaller(
                claims("alice-sub", ["knowledge:read"], {
                    iss: "https://id.example.com/realms/acme",
                }),
            ),
        ).resolves.toMatchObject({ ok: true, caller: { userId: ALICE } });
        await expect(
            resolveCaller(
                claims("alice-sub", ["knowledge:read"], {
                    iss: "https://other.example.com/realms/acme",
                }),
            ),
        ).resolves.toEqual({ ok: false, reason: "no-account" });
    });

    it("never admits the web sign-in client's tokens", async () => {
        await expect(
            resolveCaller(
                claims("alice-sub", ["knowledge:read"], { azp: "riffado" }),
            ),
        ).resolves.toEqual({ ok: false, reason: "client-not-allowed" });
    });

    it("never resolves to the organization account", async () => {
        if (!orgUserId) throw new Error("organization account missing");
        await db().insert(accounts).values({
            userId: orgUserId,
            providerId: "oidc",
            accountId: "org-sub",
        });
        await expect(
            resolveCaller(claims("org-sub", ["knowledge:read"])),
        ).resolves.toEqual({ ok: false, reason: "no-account" });
    });
});
