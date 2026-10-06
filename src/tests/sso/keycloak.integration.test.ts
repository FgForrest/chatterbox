/**
 * The whole authorization-code flow against a real Keycloak: better-auth
 * starts the sign-in, the test fills in Keycloak's login form over HTTP, and
 * better-auth takes the callback, exchanging the code at Keycloak.
 *
 * Opt-in. Needs `TEST_DATABASE_URL` (see the other integration tests) and
 * `KEYCLOAK_TEST_ISSUER`, the realm of `docker-compose.e2e.sso.yml`:
 *
 *   docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.sso.yml up -d --wait keycloak
 *   KEYCLOAK_TEST_ISSUER=http://localhost:8180/realms/riffado-e2e \
 *   TEST_DATABASE_URL=... vitest run src/tests/sso/keycloak.integration.test.ts
 *
 * Keycloak's issuer is its KC_HOSTNAME (`RIFFADO_E2E_KEYCLOAK_URL`, default
 * `http://localhost:8180`), so start it with the URL this test reaches it at.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, people, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const APP_URL = "http://localhost:3000";

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
            SELF_HOST_MODE: "shared" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: "org@example.com" as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            OIDC_ISSUER_URL: process.env.KEYCLOAK_TEST_ISSUER?.replace(
                /\/+$/,
                "",
            ),
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "riffado-e2e-client-secret",
            OIDC_PROVIDER_NAME: "Keycloak",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: false,
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
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { ensureOrgAccount } from "@/lib/org/account";

/** The value, or a failed test when it is missing. */
function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) {
        throw new Error("expected a value");
    }
    return value;
}

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && mockEnv.OIDC_ISSUER_URL ? describe : describe.skip;

/** Cookie jar of one browser, per origin. */
class Browser {
    private readonly jar = new Map<string, Map<string, string>>();

    store(url: string, response: Response) {
        const origin = new URL(url).origin;
        const cookies = this.jar.get(origin) ?? new Map<string, string>();
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(";");
            const index = required(pair).indexOf("=");
            cookies.set(
                required(pair).slice(0, index),
                required(pair).slice(index + 1),
            );
        }
        this.jar.set(origin, cookies);
    }

    cookie(url: string): string {
        const cookies = this.jar.get(new URL(url).origin);
        return cookies
            ? [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
            : "";
    }
}

function decodeHtml(value: string): string {
    return value.replaceAll("&amp;", "&");
}

/** Sign in at Keycloak as `username`; returns where the app sent the browser. */
async function keycloakLogin(username: string): Promise<string> {
    const browser = new Browser();

    const startUrl = `${APP_URL}/api/auth/sign-in/oauth2`;
    const start = await auth.handler(
        new Request(startUrl, {
            method: "POST",
            headers: { "content-type": "application/json", origin: APP_URL },
            body: JSON.stringify({
                providerId: "oidc",
                callbackURL: "/dashboard",
                errorCallbackURL: "/login",
            }),
        }),
    );
    browser.store(startUrl, start);
    const { url: authorizationUrl } = (await start.json()) as { url: string };

    const loginPage = await fetch(authorizationUrl, { redirect: "manual" });
    browser.store(authorizationUrl, loginPage);
    const html = await loginPage.text();
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(
        html,
    )?.[1];
    if (!action) throw new Error("Keycloak login form not found");
    const actionUrl = decodeHtml(action);

    const submitted = await fetch(actionUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: browser.cookie(actionUrl),
        },
        body: new URLSearchParams({
            username,
            password: `${username}-password`,
            credentialId: "",
        }),
    });
    expect(submitted.status).toBe(302);
    const callbackUrl = submitted.headers.get("location") ?? "";
    expect(
        callbackUrl.startsWith(`${APP_URL}/api/auth/oauth2/callback/oidc`),
    ).toBe(true);

    const callback = await auth.handler(
        new Request(callbackUrl, {
            headers: { cookie: browser.cookie(callbackUrl) },
        }),
    );
    expect(callback.status).toBe(302);
    return callback.headers.get("location") ?? "";
}

describeWithKeycloak("single sign-on with Keycloak", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }
    let orgUserId = "";

    async function userByEmail(email: string) {
        const [row] = await db()
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        return row ?? null;
    }

    async function hasSsoAccount(userId: string): Promise<boolean> {
        const rows = await db()
            .select({ id: accounts.id })
            .from(accounts)
            .where(
                and(
                    eq(accounts.userId, userId),
                    eq(accounts.providerId, "oidc"),
                ),
            );
        return rows.length > 0;
    }

    async function passwordUser(email: string): Promise<string> {
        const [user] = await db()
            .insert(users)
            .values({ email, name: email, emailVerified: false })
            .returning({ id: users.id });
        if (!user) throw new Error("user was not created");
        await db().insert(accounts).values({
            userId: user.id,
            accountId: user.id,
            providerId: "credential",
            password: "not-a-real-hash",
        });
        return user.id;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "keycloak",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    });

    it("signs a new user in and records them in the Organization Almanac", async () => {
        expect(await keycloakLogin("alice")).toBe("/dashboard");
        const alice = await userByEmail("alice@example.com");
        expect(alice?.name).toBe("Alice Example");
        expect(alice?.emailVerified).toBe(true);
        expect(await hasSsoAccount(required(alice).id)).toBe(true);

        const [person] = await db()
            .select({ id: people.id })
            .from(people)
            .where(
                and(
                    eq(people.userId, orgUserId),
                    eq(
                        people.primaryEmailHash,
                        lookupHash("alice@example.com"),
                    ),
                ),
            );
        expect(person).toBeDefined();
    });

    it("creates a user whose email Keycloak has not verified", async () => {
        expect(await keycloakLogin("bob")).toBe("/dashboard");
        expect((await userByEmail("bob@example.com"))?.emailVerified).toBe(
            false,
        );
    });

    it("links an existing password account by verified email", async () => {
        const carolId = await passwordUser("carol@example.com");
        expect(await keycloakLogin("carol")).toBe("/dashboard");
        expect(await hasSsoAccount(carolId)).toBe(true);
    });

    it("refuses to link an existing account by unverified email", async () => {
        const daveId = await passwordUser("dave@example.com");
        expect(await keycloakLogin("dave")).toBe(
            "/login?error=account_not_linked",
        );
        expect(await hasSsoAccount(daveId)).toBe(false);
    });
});
