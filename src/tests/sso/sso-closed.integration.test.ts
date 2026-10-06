/**
 * Single sign-on on a closed instance (`DISABLE_REGISTRATION=true`): the
 * identity provider signs existing accounts in and creates no new ones.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import { createFakeIdentityProvider } from "@/tests/sso/fake-idp";

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
            BILLING_ENABLED: undefined as boolean | undefined,
            SELF_HOST_MODE: "local" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: undefined as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            OIDC_ISSUER_URL: "https://idp.example.test/realms/acme",
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "client-secret",
            OIDC_PROVIDER_NAME: "Acme SSO",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: true,
            APP_URL: "http://localhost:3000",
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
vi.mock("@/lib/hosted/billing/cycle-close", () => ({
    closeCycleForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendEmailChangeConfirm: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendVerifyEmail: vi.fn(),
}));

import { auth } from "@/lib/auth";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const idp = createFakeIdentityProvider(() => auth.handler);

describeWithDatabase("single sign-on on a closed instance", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function ssoAccounts(userId: string) {
        return db()
            .select({ accountId: accounts.accountId })
            .from(accounts)
            .where(
                and(
                    eq(accounts.userId, userId),
                    eq(accounts.providerId, "oidc"),
                ),
            );
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "sso_closed",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        vi.spyOn(globalThis, "fetch").mockImplementation(idp.fetch);
    }, 120_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        dbRef.current = null;
        await database?.dispose();
    });

    it("creates no account for someone new", async () => {
        const { location } = await idp.login({
            sub: "sub-newcomer",
            email: "newcomer@example.test",
            email_verified: true,
            name: "Newcomer",
        });
        expect(location).toBe("/login?error=signup_disabled");
        const created = await db()
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, "newcomer@example.test"));
        expect(created).toEqual([]);
    });

    it("signs an existing account in and links it", async () => {
        const [user] = await db()
            .insert(users)
            .values({ email: "kim@example.test", name: "Kim" })
            .returning({ id: users.id });
        if (!user) throw new Error("user was not created");

        const first = await idp.login({
            sub: "sub-kim",
            email: "kim@example.test",
            email_verified: true,
            name: "Kim Example",
        });
        expect(first.location).toBe("/dashboard");
        expect(await ssoAccounts(user.id)).toEqual([{ accountId: "sub-kim" }]);

        const again = await idp.login({
            sub: "sub-kim",
            email: "kim@example.test",
            email_verified: true,
            name: "Kim Example",
        });
        expect(again.location).toBe("/dashboard");
    });

    it("still refuses to link an email the provider did not verify", async () => {
        const [user] = await db()
            .insert(users)
            .values({ email: "lee@example.test", name: "Lee" })
            .returning({ id: users.id });
        if (!user) throw new Error("user was not created");

        const { location } = await idp.login({
            sub: "sub-lee",
            email: "lee@example.test",
            email_verified: false,
            name: "Lee Example",
        });
        expect(location).toBe("/login?error=account_not_linked");
        expect(await ssoAccounts(user.id)).toEqual([]);
    });
});
