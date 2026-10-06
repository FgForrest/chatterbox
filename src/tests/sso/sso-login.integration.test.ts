/**
 * Single sign-on through better-auth against a real PostgreSQL, with the
 * identity provider faked at the HTTP boundary: discovery and token
 * endpoints answer from `fetch`, the ID token carries the claims under test.
 *
 * Covers who gets in and as whom (new users, linking by verified email,
 * the organization account), what is kept (no provider tokens, a fixed
 * session lifetime), the Almanac record, and that password endpoints are
 * gone.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    accounts,
    instanceState,
    knowledgeAliases,
    people,
    sessions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    TEST_APP_URL as APP_URL,
    createFakeIdentityProvider,
} from "@/tests/sso/fake-idp";

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
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            OIDC_ISSUER_URL: "https://idp.example.test/realms/acme",
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "client-secret",
            OIDC_PROVIDER_NAME: "Acme SSO",
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

import {
    clearSsoSessionsMarker,
    revokeSessionsOnSsoSwitch,
} from "@/db/queries/sso";
import { auth } from "@/lib/auth";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { ensureOrgAccount } from "@/lib/org/account";
import { guardSsoSession } from "@/lib/sso/auth-hooks";

/** The value, or a failed test when it is missing. */
function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) {
        throw new Error("expected a value");
    }
    return value;
}

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const idp = createFakeIdentityProvider(() => auth.handler);
const ssoLogin = idp.login;

describeWithDatabase("single sign-on (PostgreSQL, fake IdP)", () => {
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

    async function ssoAccountOf(userId: string) {
        const [row] = await db()
            .select()
            .from(accounts)
            .where(
                and(
                    eq(accounts.userId, userId),
                    eq(accounts.providerId, "oidc"),
                ),
            )
            .limit(1);
        return row ?? null;
    }

    async function personByEmail(ownerId: string, email: string) {
        const [row] = await db()
            .select()
            .from(people)
            .where(
                and(
                    eq(people.userId, ownerId),
                    eq(people.primaryEmailHash, lookupHash(email)),
                ),
            )
            .limit(1);
        return row ?? null;
    }

    async function passwordUser(email: string, name: string) {
        const [user] = await db()
            .insert(users)
            .values({ email, name, emailVerified: false })
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
            "sso",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        vi.spyOn(globalThis, "fetch").mockImplementation(idp.fetch);
        orgUserId = (await ensureOrgAccount()) ?? "";
    }, 120_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        dbRef.current = null;
        await database?.dispose();
    });

    beforeEach(() => {
        mockEnv.SELF_HOST_MODE = "shared";
    });

    it("created the organization account without a password", async () => {
        expect(orgUserId).not.toBe("");
        const credential = await db()
            .select()
            .from(accounts)
            .where(eq(accounts.userId, orgUserId));
        expect(credential).toEqual([]);
    });

    it("signs a new user in, without keeping the provider's tokens", async () => {
        const { location, cookie } = await ssoLogin({
            sub: "sub-ann",
            email: "Ann@Example.test",
            email_verified: true,
            name: "Ann Example",
        });
        expect(location).toBe("/dashboard");
        expect(cookie).toContain("session_token");

        const ann = await userByEmail("ann@example.test");
        expect(ann?.name).toBe("Ann Example");
        expect(ann?.emailVerified).toBe(true);

        const account = await ssoAccountOf(required(ann).id);
        expect(account?.accountId).toBe("sub-ann");
        expect(account?.accessToken).toBeNull();
        expect(account?.refreshToken).toBeNull();
        expect(account?.idToken).toBeNull();

        const [session] = await db()
            .select()
            .from(sessions)
            .where(eq(sessions.userId, required(ann).id));
        const lifetime = required(session).expiresAt.getTime() - Date.now();
        expect(lifetime).toBeGreaterThan(24 * 60 * 60 * 1000 - 60_000);
        expect(lifetime).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    it("puts the user into the Organization Almanac and keeps them current", async () => {
        await ssoLogin({
            sub: "sub-eve",
            email: "eve@example.test",
            email_verified: true,
            name: "Eve Example",
        });
        const eve = await userByEmail("eve@example.test");
        const person = await personByEmail(orgUserId, "eve@example.test");
        expect(person).not.toBeNull();
        expect(decryptText(required(person).displayName)).toBe("Eve Example");
        expect(required(person).createdByUserId).toBe(required(eve).id);

        await db()
            .insert(knowledgeAliases)
            .values({
                userId: orgUserId,
                personId: required(person).id,
                kind: "alias",
                text: encryptText("Evie"),
                textHmac: "evie-hmac",
            });

        await ssoLogin({
            sub: "sub-eve",
            email: "eve@example.test",
            email_verified: true,
            name: "Eve Q. Example",
        });
        const records = await db()
            .select()
            .from(people)
            .where(eq(people.primaryEmailHash, lookupHash("eve@example.test")));
        expect(records).toHaveLength(1);
        expect(decryptText(required(records[0]).displayName)).toBe(
            "Eve Q. Example",
        );
        expect((await userByEmail("eve@example.test"))?.name).toBe(
            "Eve Q. Example",
        );
        const aliases = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.personId, required(person).id));
        expect(aliases).toHaveLength(1);
    });

    it("uses the user's own Almanac when the Organization scope is off", async () => {
        mockEnv.SELF_HOST_MODE = "local";
        await ssoLogin({
            sub: "sub-finn",
            email: "finn@example.test",
            email_verified: true,
            name: "Finn Example",
        });
        const finn = await userByEmail("finn@example.test");
        expect(
            await personByEmail(required(finn).id, "finn@example.test"),
        ).not.toBe(null);
        expect(await personByEmail(orgUserId, "finn@example.test")).toBe(null);
    });

    it("links a password account when the provider verified the email", async () => {
        const bobId = await passwordUser("bob@example.test", "Bob");
        const { location } = await ssoLogin({
            sub: "sub-bob",
            email: "bob@example.test",
            email_verified: true,
            name: "Bob Example",
        });
        expect(location).toBe("/dashboard");
        expect((await ssoAccountOf(bobId))?.accountId).toBe("sub-bob");
        const bob = await userByEmail("bob@example.test");
        expect(bob?.id).toBe(bobId);
        expect(bob?.name).toBe("Bob Example");
    });

    it("refuses to link when the provider did not verify the email", async () => {
        const carolId = await passwordUser("carol@example.test", "Carol");
        const { location } = await ssoLogin({
            sub: "sub-carol",
            email: "carol@example.test",
            email_verified: false,
            name: "Carol Example",
        });
        expect(location).toBe("/login?error=account_not_linked");
        expect(await ssoAccountOf(carolId)).toBeNull();
    });

    it("creates a new user with an unverified email nobody holds", async () => {
        const { location } = await ssoLogin({
            sub: "sub-dave",
            email: "dave@example.test",
            email_verified: false,
            name: "Dave Example",
        });
        expect(location).toBe("/dashboard");
        expect((await userByEmail("dave@example.test"))?.emailVerified).toBe(
            false,
        );
    });

    it("never signs anyone in as the organization account", async () => {
        const { location } = await ssoLogin({
            sub: "sub-org",
            email: "org@example.test",
            email_verified: true,
            name: "Someone",
        });
        expect(location).toBe("/login?error=unable_to_link_account");
        expect(await ssoAccountOf(orgUserId)).toBeNull();
        const orgSessions = await db()
            .select()
            .from(sessions)
            .where(eq(sessions.userId, orgUserId));
        expect(orgSessions).toEqual([]);
        await expect(guardSsoSession({ userId: orgUserId })).rejects.toThrow(
            "The organization account cannot sign in",
        );
    });

    it("follows the provider's email, but not onto another account's", async () => {
        await ssoLogin({
            sub: "sub-gus",
            email: "gus@example.test",
            email_verified: true,
            name: "Gus",
        });
        const gus = await userByEmail("gus@example.test");

        const taken = await ssoLogin({
            sub: "sub-gus",
            email: "bob@example.test",
            email_verified: true,
            name: "Gus",
        });
        expect(taken.location).toBe("/dashboard");
        expect((await userByEmail("bob@example.test"))?.id).not.toBe(
            required(gus).id,
        );

        await ssoLogin({
            sub: "sub-gus",
            email: "gus.new@example.test",
            email_verified: true,
            name: "Gus",
        });
        expect((await userByEmail("gus.new@example.test"))?.id).toBe(
            required(gus).id,
        );
    });

    it.each([
        "/sign-in/email",
        "/sign-up/email",
        "/request-password-reset",
        "/reset-password",
    ])("switches off %s", async (path) => {
        const response = await auth.handler(
            new Request(`${APP_URL}/api/auth${path}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: APP_URL,
                },
                body: JSON.stringify({
                    email: "bob@example.test",
                    password: "a-long-password",
                    name: "Bob",
                    newPassword: "another-long-password",
                    token: "token",
                }),
            }),
        );
        expect(response.status).toBe(404);
    });

    it("ends existing sessions once per switch to SSO", async () => {
        await db().delete(instanceState);
        const before = await db().select().from(sessions);
        expect(before.length).toBeGreaterThan(0);

        expect(await revokeSessionsOnSsoSwitch()).toBe(before.length);
        expect(await db().select().from(sessions)).toEqual([]);

        await ssoLogin({
            sub: "sub-ann",
            email: "ann@example.test",
            email_verified: true,
            name: "Ann Example",
        });
        expect(await revokeSessionsOnSsoSwitch()).toBeNull();
        expect(await db().select().from(sessions)).toHaveLength(1);

        await clearSsoSessionsMarker();
        expect(await revokeSessionsOnSsoSwitch()).toBe(1);
    });
});
