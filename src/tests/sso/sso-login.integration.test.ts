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

import { createHmac } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
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
import {
    accounts,
    instanceState,
    knowledgeAliases,
    people,
    personEmails,
    sessions,
    users,
} from "@/db/schema";
import type * as AuthModule from "@/lib/auth";
import type * as AlmanacModule from "@/lib/sso/almanac";
import { recordSsoUserInAlmanac } from "@/lib/sso/almanac";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    TEST_APP_URL as APP_URL,
    createFakeIdentityProvider,
} from "@/tests/sso/fake-idp";

const { dbProxy, dbRef, mockEnv, idpRef } = vi.hoisted(() => {
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
        idpRef: {
            discoveryAvailable: true,
            discoveryRequests: 0,
            current: null as ReturnType<
                typeof createFakeIdentityProvider
            > | null,
        },
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            AUTHZ_MODE: "local" as "local" | "idp",
            IDENTITY_PROVIDER: "keycloak",
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            MCP_SERVICE_CLIENTS: [] as string[],
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

vi.mock("@/lib/auth", async (importOriginal) => {
    const idp = createFakeIdentityProvider(() => auth.handler);
    idpRef.current = idp;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/.well-known/openid-configuration")) {
            idpRef.discoveryRequests++;
            if (!idpRef.discoveryAvailable) {
                return Promise.resolve(
                    Response.json({ error: "unavailable" }, { status: 503 }),
                );
            }
        }
        return idp.fetch(input, init);
    });
    return importOriginal<typeof AuthModule>();
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/sso/almanac", async (importOriginal) => {
    const original = await importOriginal<typeof AlmanacModule>();
    return {
        ...original,
        recordSsoUserInAlmanac: vi.fn(original.recordSsoUserInAlmanac),
    };
});
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

import { GET as authRouteGet } from "@/app/api/auth/[...all]/route";
import {
    clearSsoSessionsMarker,
    revokeSessionsOnSsoSwitch,
} from "@/db/queries/sso";
import { auth, resetAuthDiscoveryForTests } from "@/lib/auth";
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

const idp = idpRef.current;
if (!idp) throw new Error("fake identity provider was not initialized");
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

    async function knownPerson(
        displayName: string,
        email: string,
        ownerId = orgUserId,
    ) {
        const [row] = await db()
            .insert(people)
            .values({
                userId: ownerId,
                displayName: encryptText(displayName),
                primaryEmail: encryptText(email),
                primaryEmailHash: lookupHash(email),
            })
            .returning();
        return required(row);
    }

    async function personById(id: string) {
        const [row] = await db()
            .select()
            .from(people)
            .where(eq(people.id, id))
            .limit(1);
        return required(row);
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
        orgUserId = (await ensureOrgAccount()) ?? "";
    }, 120_000);

    afterAll(async () => {
        resetAuthDiscoveryForTests();
        vi.restoreAllMocks();
        dbRef.current = null;
        await database?.dispose();
    });

    beforeEach(() => {
        mockEnv.SELF_HOST_MODE = "shared";
        mockEnv.AUTHZ_MODE = "local";
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("imports auth without discovery or touching a context", () => {
        expect(idpRef.discoveryRequests).toBe(0);
    });

    it("serves existing sessions and sign-out during hung startup and background retries, then recovers", async () => {
        resetAuthDiscoveryForTests({
            discoveryTimeoutMs: 100,
            candidateTimeoutMs: 150,
            retryIntervalMs: 1000,
        });
        const userId = await passwordUser(
            "discovery@example.test",
            "Discovery Example",
        );
        const cookies: string[] = [];
        for (let index = 0; index < 4; index++) {
            const token = `discovery-session-${index}`;
            await db()
                .insert(sessions)
                .values({
                    userId,
                    token,
                    expiresAt: new Date(Date.now() + 3600_000),
                });
            const signature = createHmac("sha256", mockEnv.BETTER_AUTH_SECRET)
                .update(token)
                .digest("base64");
            cookies.push(
                `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
            );
        }
        const discoveries = idpRef.discoveryRequests;
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockImplementation((input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith("/.well-known/openid-configuration")) {
                idpRef.discoveryRequests++;
                return new Promise<Response>(() => {});
            }
            return idp.fetch(input, init);
        });
        const request = (path: string, cookie = cookies[0]) =>
            new Request(`${APP_URL}/api/auth${path}`, {
                method: path === "/sign-out" ? "POST" : "GET",
                headers: { cookie, origin: APP_URL },
            });
        const start = () =>
            auth.handler(
                new Request(`${APP_URL}/api/auth/sign-in/social`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        origin: APP_URL,
                    },
                    body: JSON.stringify({
                        provider: "oidc",
                        callbackURL: "/dashboard",
                    }),
                }),
            );
        async function promptly<T>(operation: Promise<T>): Promise<T> {
            return Promise.race([
                operation,
                pause(800).then(() => {
                    throw new Error("Auth waited on discovery");
                }),
            ]);
        }
        async function checkSessions(signOutCookie: string) {
            const response = await promptly(
                auth.handler(request("/get-session")),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                user: { id: userId },
            });
            expect(
                await promptly(
                    auth.api.getSession({
                        headers: new Headers({ cookie: cookies[0] }),
                    }),
                ),
            ).toMatchObject({ user: { id: userId } });
            const signedOut = await promptly(
                auth.fetch(request("/sign-out", signOutCookie)),
            );
            expect(signedOut.status).toBe(200);
            expect(await signedOut.json()).toEqual({ success: true });
        }
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        try {
            const initial = start();
            await checkSessions(cookies[1]);
            expect(idpRef.discoveryRequests).toBe(discoveries + 1);
            await vi.advanceTimersByTimeAsync(150);
            const unavailable = await promptly(initial);
            expect(unavailable.status).toBe(503);
            expect(await unavailable.json()).toMatchObject({
                code: "SSO_UNAVAILABLE",
            });
            const initialContext = await auth.$context;
            const signInSocial = auth.api.signInSocial;
            const options = auth.options;
            expect(initialContext.socialProviders).toEqual([]);
            expect((await start()).status).toBe(503);
            expect(idpRef.discoveryRequests).toBe(discoveries + 1);
            await vi.advanceTimersByTimeAsync(850);
            expect(idpRef.discoveryRequests).toBe(discoveries + 2);
            await checkSessions(cookies[2]);
            expect((await promptly(start())).status).toBe(503);
            await vi.advanceTimersByTimeAsync(150);
            fetchMock.mockImplementation(idp.fetch);
            await vi.advanceTimersByTimeAsync(850);
            await vi.waitFor(async () =>
                expect(
                    (await auth.$context).socialProviders.map((p) => p.id),
                ).toContain("oidc"),
            );
            expect(await auth.$context).not.toBe(initialContext);
            expect(auth.options).not.toBe(options);
            expect(auth.fetch).toBe(auth.handler);
            const calls = fetchMock.mock.calls.length;
            await vi.advanceTimersByTimeAsync(3000);
            expect(fetchMock).toHaveBeenCalledTimes(calls);
            vi.useRealTimers();
            const [first, second, direct] = await promptly(
                Promise.all([
                    start(),
                    start(),
                    signInSocial({ body: { provider: "oidc" } }),
                ]),
            );
            expect([first.status, second.status]).toEqual([200, 200]);
            expect(direct.url).toContain("/protocol/openid-connect/auth?");
        } finally {
            vi.useRealTimers();
            fetchMock.mockImplementation(idp.fetch);
            resetAuthDiscoveryForTests();
            await auth.$context;
        }
    });

    it("discards a candidate that initializes after its deadline", async () => {
        resetAuthDiscoveryForTests({
            discoveryTimeoutMs: 1000,
            candidateTimeoutMs: 50,
            retryIntervalMs: 1000,
        });
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fetchMock = vi.mocked(globalThis.fetch);
        let requests = 0;
        fetchMock.mockImplementation(async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (
                url.endsWith("/.well-known/openid-configuration") &&
                ++requests === 1
            )
                await waiting;
            return idp.fetch(input, init);
        });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        try {
            const pending = auth.$context;
            await vi.advanceTimersByTimeAsync(50);
            const fallback = await pending;
            expect(fallback.socialProviders).toEqual([]);
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(await auth.$context).toBe(fallback);
            expect(requests).toBe(1);
            await vi.advanceTimersByTimeAsync(950);
            await vi.waitFor(async () =>
                expect(
                    (await auth.$context).socialProviders.map((p) => p.id),
                ).toContain("oidc"),
            );
            expect(requests).toBe(2);
        } finally {
            release();
            vi.useRealTimers();
            fetchMock.mockImplementation(idp.fetch);
            resetAuthDiscoveryForTests();
            await auth.$context;
        }
    });

    it("waits for a slow but healthy first discovery without an unavailable retry window", async () => {
        resetAuthDiscoveryForTests({
            discoveryTimeoutMs: 1000,
            candidateTimeoutMs: 1200,
        });
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockImplementation(async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith("/.well-known/openid-configuration"))
                await waiting;
            return idp.fetch(input, init);
        });
        const pending = auth.api.signInSocial({ body: { provider: "oidc" } });
        await expect(
            auth.api.getSession({ headers: new Headers() }),
        ).resolves.toBeNull();
        release();
        try {
            expect((await pending).url).toContain(
                "/protocol/openid-connect/auth?",
            );
        } finally {
            release();
            fetchMock.mockImplementation(idp.fetch);
        }
    });

    it("keeps refusal hooks and database hooks on the provider-free fallback", async () => {
        resetAuthDiscoveryForTests();
        idpRef.discoveryAvailable = false;
        vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            return url.endsWith("/.well-known/openid-configuration")
                ? Promise.resolve(new Response(null, { status: 503 }))
                : idp.fetch(input, init);
        });
        try {
            const fallback = await auth.$context;
            expect(fallback.socialProviders).toEqual([]);
            const refused = await auth.handler(
                new Request(`${APP_URL}/api/auth/sign-in/email`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                }),
            );
            expect(refused.status).toBe(404);
            await expect(
                auth.api.signInSocial({
                    body: { provider: "oidc", idToken: { token: "unused" } },
                }),
            ).rejects.toMatchObject({
                statusCode: 403,
                body: { code: "SSO_ID_TOKEN_SIGN_IN_DISABLED" },
            });
            await expect(
                fallback.internalAdapter.createSession(orgUserId, false),
            ).rejects.toMatchObject({ body: { code: "ORG_ACCOUNT_SSO" } });
            await expect(
                fallback.internalAdapter.linkAccount({
                    userId: orgUserId,
                    providerId: "oidc",
                    accountId: "fallback-org",
                }),
            ).rejects.toMatchObject({ body: { code: "ORG_ACCOUNT_SSO" } });
            const user = await fallback.internalAdapter.createUser(
                {
                    name: "Fallback Example",
                    email: "fallback@example.test",
                    emailVerified: true,
                    image: "https://example.test/image.png",
                },
                { method: "oauth", oauth: { providerId: "oidc" } },
            );
            expect(user.image).toBeNull();
        } finally {
            idpRef.discoveryAvailable = true;
            vi.mocked(globalThis.fetch).mockImplementation(idp.fetch);
            resetAuthDiscoveryForTests();
            await auth.$context;
        }
    });

    it("keeps the initialized instance when its provider is present", async () => {
        const context = await auth.$context;
        const discoveries = idpRef.discoveryRequests;
        const clock = vi
            .spyOn(Date, "now")
            .mockReturnValue(Date.now() + 300_000);
        try {
            expect(
                await auth.api.getSession({ headers: new Headers() }),
            ).toBeNull();
            expect(
                (await auth.fetch(new Request(`${APP_URL}/api/auth/ok`)))
                    .status,
            ).toBe(200);
            expect(await auth.$context).toBe(context);
            expect(idpRef.discoveryRequests).toBe(discoveries);
        } finally {
            clock.mockRestore();
        }
    });

    it("serves the Next.js auth route through the guarded handler", async () => {
        expect("handler" in auth).toBe(true);
        expect("getSession" in auth.api).toBe(true);
        expect("then" in auth.api).toBe(false);
        expect(Object.keys(auth.api)).toContain("signInSocial");
        expect(auth.api.getSession).toBe(auth.api.getSession);
        expect(auth.api.getSession.path).toBe("/get-session");
        expect({ ...auth }.handler).toBe(auth.handler);
        const response = await authRouteGet(
            new Request(`${APP_URL}/api/auth/get-session`),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toBeNull();
        const callback = await authRouteGet(
            new Request(
                `${APP_URL}/api/auth/oauth2/callback/oidc?code=forged&state=forged`,
            ),
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toContain(
            "error=state_mismatch",
        );
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
            picture: "https://example.test/profile.png",
        });
        expect(location).toBe("/dashboard");
        expect(cookie).toContain("session_token");

        const ann = await userByEmail("ann@example.test");
        expect(ann?.name).toBe("Ann Example");
        expect(ann?.emailVerified).toBe(true);
        expect(ann?.image).toBeNull();

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

    it.each([
        "local",
        "idp",
    ] as const)("refuses direct ID-token sign-in in %s authorization mode before inspecting the token", async (mode) => {
        let token = "";
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockImplementation(async (input, init) => {
            const response = await idp.fetch(input, init);
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith("/protocol/openid-connect/token")) {
                token = (
                    (await response.clone().json()) as { id_token: string }
                ).id_token;
            }
            return response;
        });
        try {
            expect(
                (
                    await ssoLogin({
                        sub: `sub-direct-${mode}`,
                        email: `direct-${mode}@example.test`,
                        email_verified: true,
                        name: "Direct Example",
                    })
                ).location,
            ).toBe("/dashboard");
        } finally {
            fetchMock.mockImplementation(idp.fetch);
        }
        expect(token).not.toBe("");
        const before = {
            users: await db().select().from(users),
            accounts: await db().select().from(accounts),
            sessions: await db().select().from(sessions),
        };
        mockEnv.AUTHZ_MODE = mode;
        fetchMock.mockClear();
        const response = await auth.handler(
            new Request(`${APP_URL}/api/auth/sign-in/social`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: APP_URL,
                },
                body: JSON.stringify({
                    provider: "oidc",
                    idToken: { token },
                    additionalData: { reauthenticate: true },
                }),
            }),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
            code: "SSO_ID_TOKEN_SIGN_IN_DISABLED",
        });
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await db().select().from(users)).toEqual(before.users);
        expect(await db().select().from(accounts)).toEqual(before.accounts);
        expect(await db().select().from(sessions)).toEqual(before.sessions);
    });

    it.each([
        null,
        "another-request-nonce",
    ])("refuses an ID token with nonce %s without creating an account or session", async (idTokenNonce) => {
        const { location, cookie } = await ssoLogin(
            {
                sub: "sub-replayed",
                email: "replayed@example.test",
                email_verified: true,
                name: "Replayed Example",
            },
            { idTokenNonce },
        );
        expect(location).toBe("/login?error=unable_to_get_user_info");
        expect(cookie).not.toContain("session_token");
        expect(await userByEmail("replayed@example.test")).toBeNull();
    });

    it("does not force reauthentication in local authorization mode", async () => {
        const response = await auth.handler(
            new Request(`${APP_URL}/api/auth/sign-in/social`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: APP_URL,
                },
                body: JSON.stringify({
                    provider: "oidc",
                    additionalData: { reauthenticate: true },
                }),
            }),
        );
        expect(response.status).toBe(200);
        const { url } = (await response.json()) as { url: string };
        const params = new URL(url).searchParams;
        expect(params.get("max_age")).toBeNull();
        expect(params.get("prompt")).toBeNull();
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
            picture: "https://example.test/changed-profile.png",
        });
        const records = await db()
            .select()
            .from(people)
            .where(eq(people.primaryEmailHash, lookupHash("eve@example.test")));
        expect(records).toHaveLength(1);
        expect(decryptText(required(records[0]).displayName)).toBe(
            "Eve Q. Example",
        );
        expect(await userByEmail("eve@example.test")).toMatchObject({
            name: "Eve Q. Example",
            image: null,
        });
        const aliases = await db()
            .select()
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.personId, required(person).id));
        expect(aliases).toHaveLength(1);
    });

    it("leaves another person's record alone at the first sign-in", async () => {
        const email = "nora@example.test";
        const other = await knownPerson("Ivana Malá", email);
        await db()
            .insert(personEmails)
            .values(
                [email, "ivana@example.test"].map((address) => ({
                    userId: orgUserId,
                    personId: other.id,
                    email: encryptText(address),
                    emailHash: lookupHash(address),
                })),
            );
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await ssoLogin({
            sub: "sub-nora",
            email,
            email_verified: true,
            name: "Nora Veselá",
        });

        const kept = await personById(other.id);
        expect(decryptText(kept.displayName)).toBe("Ivana Malá");
        expect(kept.primaryEmail).toBeNull();
        expect(kept.primaryEmailHash).toBeNull();
        expect(
            await db()
                .select({ hash: personEmails.emailHash })
                .from(personEmails)
                .where(eq(personEmails.personId, other.id)),
        ).toEqual([{ hash: lookupHash("ivana@example.test") }]);

        const holder = required(await personByEmail(orgUserId, email));
        expect(holder.id).not.toBe(other.id);
        expect(decryptText(holder.displayName)).toBe("Nora Veselá");
        expect(holder.createdByUserId).toBe(
            required(await userByEmail(email)).id,
        );

        const logged = warn.mock.calls.flat().map(String);
        expect(logged.some((line) => line.includes(other.id))).toBe(true);
        expect(
            logged.filter(
                (line) =>
                    line.includes("Ivana") ||
                    line.includes("Nora") ||
                    line.includes(email),
            ),
        ).toEqual([]);
        warn.mockRestore();

        await ssoLogin({
            sub: "sub-nora",
            email,
            email_verified: true,
            name: "Nora Skálová",
        });
        const again = required(await personByEmail(orgUserId, email));
        expect(again.id).toBe(holder.id);
        expect(decryptText(again.displayName)).toBe("Nora Skálová");
        expect(decryptText((await personById(other.id)).displayName)).toBe(
            "Ivana Malá",
        );
    });

    it.each([
        "Jan Dvorak",
        "Dvořák, Jan",
        "Honza Dvořák",
        "Honza",
        "J. Dvořák",
        "Ing. Jan Dvořák",
        "fit-address@example.test",
    ])("keeps a record named %s for Jan Dvořák at the first sign-in", async (name) => {
        const email =
            name === "fit-address@example.test"
                ? name
                : `fit-${lookupHash(name).slice(0, 12)}@example.test`;
        const person = await knownPerson(name, email);

        await ssoLogin({
            sub: `sub-${email}`,
            email,
            email_verified: true,
            name: "Jan Dvořák",
        });

        const kept = await personById(person.id);
        expect(decryptText(kept.displayName)).toBe("Jan Dvořák");
        expect(kept.primaryEmailHash).toBe(lookupHash(email));
    });

    it("follows the provider to a wholly new name after the first sign-in", async () => {
        const email = "bea@example.test";
        const person = await knownPerson("Bea Hart", email);
        const login = { sub: "sub-bea", email, email_verified: true };
        await ssoLogin({ ...login, name: "Bea Hart" });

        await ssoLogin({ ...login, name: "Cleo Stone" });

        const renamed = await personById(person.id);
        expect(decryptText(renamed.displayName)).toBe("Cleo Stone");
        expect(renamed.primaryEmailHash).toBe(lookupHash(email));
    });

    it.each([
        null,
        "  ",
        "quiet@example.test",
    ])("keeps the record when the provider's name is %j", async (name) => {
        const email = "quiet@example.test";
        const userId = await passwordUser(email, "Quiet");
        const person = await knownPerson("Rita Malá", email);
        try {
            expect(
                await recordSsoUserInAlmanac({ id: userId, name, email }),
            ).toBe(person.id);
            const kept = await personById(person.id);
            expect(decryptText(kept.displayName)).toBe("Rita Malá");
            expect(kept.primaryEmailHash).toBe(lookupHash(email));
        } finally {
            await db().delete(people).where(eq(people.id, person.id));
            await db().delete(users).where(eq(users.id, userId));
        }
    });

    it.each([
        "---",
        "🙂",
    ])("leaves another person's record alone for the provider name %s", async (name) => {
        const email = `symbols-${lookupHash(name).slice(0, 12)}@example.test`;
        const other = await knownPerson("Ivana Malá", email);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await ssoLogin({
            sub: `sub-${email}`,
            email,
            email_verified: true,
            name,
        });

        warn.mockRestore();
        const kept = await personById(other.id);
        expect(decryptText(kept.displayName)).toBe("Ivana Malá");
        expect(kept.primaryEmailHash).toBeNull();
        const holder = required(await personByEmail(orgUserId, email));
        expect(holder.id).not.toBe(other.id);
        expect(decryptText(holder.displayName)).toBe(name);
    });

    it("keeps a record the user created, for a first sign-in the stamp cannot tell", async () => {
        const email = "legacy@example.test";
        const userId = await passwordUser(email, "Legacy");
        const person = await knownPerson("Rita Malá", email);
        await db()
            .update(people)
            .set({ createdByUserId: userId })
            .where(eq(people.id, person.id));

        expect(
            await recordSsoUserInAlmanac({
                id: userId,
                name: "Tea Hart",
                email,
            }),
        ).toBe(person.id);

        expect(decryptText((await personById(person.id)).displayName)).toBe(
            "Tea Hart",
        );
    });

    it("still checks whose record it is after a first sign-in that recorded nobody", async () => {
        const email = "lea@example.test";
        const login = {
            sub: "sub-lea",
            email,
            email_verified: true,
            name: "Lea Veselá",
        };
        const other = await knownPerson("Ivana Malá", email);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(recordSsoUserInAlmanac).mockRejectedValueOnce(
            new Error("database down"),
        );

        await ssoLogin(login);

        expect(required(await userByEmail(email)).lastSsoLoginAt).toBeNull();
        expect(error).toHaveBeenCalled();
        error.mockRestore();

        await ssoLogin(login);

        const kept = await personById(other.id);
        expect(decryptText(kept.displayName)).toBe("Ivana Malá");
        expect(kept.primaryEmailHash).toBeNull();
        const holder = required(await personByEmail(orgUserId, email));
        expect(decryptText(holder.displayName)).toBe("Lea Veselá");
        expect(
            required(await userByEmail(email)).lastSsoLoginAt,
        ).not.toBeNull();
    });

    it("keeps a returning user's addresses active when recording fails", async () => {
        const email = "mia@example.test";
        const login = {
            sub: "sub-mia",
            email,
            email_verified: true,
            name: "Mia Hart",
        };
        await ssoLogin(login);
        const longAgo = new Date("2026-01-01T00:00:00.000Z");
        await db()
            .update(users)
            .set({ lastSsoLoginAt: longAgo })
            .where(eq(users.email, email));
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(recordSsoUserInAlmanac).mockRejectedValueOnce(
            new Error("database down"),
        );

        await ssoLogin(login);

        error.mockRestore();
        expect(
            required(
                required(await userByEmail(email)).lastSsoLoginAt,
            ).getTime(),
        ).toBeGreaterThan(longAgo.getTime());
    });

    it("names a new record by the address when the provider gives no name", async () => {
        const email = "unnamed@example.test";
        const userId = await passwordUser(email, "Unnamed");

        const id = await recordSsoUserInAlmanac({
            id: userId,
            name: null,
            email,
        });

        expect(decryptText((await personById(required(id))).displayName)).toBe(
            email,
        );
    });

    it("keeps a record in the user's own Almanac whatever its name", async () => {
        mockEnv.SELF_HOST_MODE = "local";
        const email = "own@example.test";
        const userId = await passwordUser(email, "Own");
        const person = await knownPerson("Rita Malá", email, userId);

        await ssoLogin({
            sub: "sub-own",
            email,
            email_verified: true,
            name: "Olga Veselá",
        });

        const kept = await personById(person.id);
        expect(decryptText(kept.displayName)).toBe("Olga Veselá");
        expect(kept.primaryEmailHash).toBe(lookupHash(email));
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
        expect(new URL(location, APP_URL).searchParams.get("error")).toBe(
            "ORG_ACCOUNT_SSO",
        );
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

    it("enforces one provider identity across users at the database", async () => {
        const first = await passwordUser(
            "unique-first@example.test",
            "First Example",
        );
        const second = await passwordUser(
            "unique-second@example.test",
            "Second Example",
        );
        await db().insert(accounts).values({
            userId: first,
            providerId: "oidc",
            accountId: "unique-subject",
        });
        await expect(
            db().insert(accounts).values({
                userId: second,
                providerId: "oidc",
                accountId: "unique-subject",
            }),
        ).rejects.toMatchObject({
            cause: {
                code: "23505",
                constraint_name: "accounts_provider_account_idx",
            },
        });
    });

    it("serializes concurrent first links by the unique index and permits the next sign-in", async () => {
        const userId = await passwordUser("race@example.test", "Race Example");
        const context = await auth.$context;
        const link = context.internalAdapter.linkAccount.bind(
            context.internalAdapter,
        );
        let reached = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        const spy = vi
            .spyOn(context.internalAdapter, "linkAccount")
            .mockImplementation(async (...args) => {
                reached++;
                if (reached === 2) release();
                await barrier;
                return link(...args);
            });
        const claims = {
            sub: "race-subject",
            email: "race@example.test",
            email_verified: true,
            name: "Race Example",
        };
        const pending = Promise.all([ssoLogin(claims), ssoLogin(claims)]);
        try {
            const results = await pending;
            expect(reached).toBe(2);
            expect(results.map((result) => result.location).sort()).toEqual([
                "/dashboard",
                "/login?error=unable_to_link_account",
            ]);
            const losing = required(
                results.find((result) => result.location.startsWith("/login")),
            );
            expect(losing.cookie).not.toContain("session_token");
            expect(
                await db()
                    .select()
                    .from(accounts)
                    .where(
                        and(
                            eq(accounts.userId, userId),
                            eq(accounts.providerId, "oidc"),
                        ),
                    ),
            ).toHaveLength(1);
            expect(
                await db()
                    .select()
                    .from(sessions)
                    .where(eq(sessions.userId, userId)),
            ).toHaveLength(1);
        } finally {
            release();
            await pending;
            spy.mockRestore();
        }
        expect((await ssoLogin(claims)).location).toBe("/dashboard");
    });

    it.each([
        "local",
        "idp",
    ] as const)("binds sub without advertised signing algorithms in %s mode", async (mode) => {
        mockEnv.AUTHZ_MODE = mode;
        const algorithms = idp.discovery.id_token_signing_alg_values_supported;
        delete idp.discovery.id_token_signing_alg_values_supported;
        resetAuthDiscoveryForTests();
        try {
            const sub = `no-algorithms-${mode}`;
            const email = `${sub}@example.test`;
            const result = await ssoLogin({
                sub,
                email,
                email_verified: true,
                name: "Subject Example",
            });
            expect(result.location).toBe("/dashboard");
            expect(
                (await ssoAccountOf(required(await userByEmail(email)).id))
                    ?.accountId,
            ).toBe(sub);
        } finally {
            idp.discovery.id_token_signing_alg_values_supported = algorithms;
            mockEnv.AUTHZ_MODE = "local";
            resetAuthDiscoveryForTests();
            await auth.$context;
        }
    });

    it.each([
        "jwks_uri",
        "issuer",
    ])("refuses discovery without %s and recovers through a background retry", async (field) => {
        const value = idp.discovery[field];
        delete idp.discovery[field];
        resetAuthDiscoveryForTests({ retryIntervalMs: 1000 });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        try {
            await expect(
                auth.api.signInSocial({ body: { provider: "oidc" } }),
            ).rejects.toMatchObject({
                statusCode: 503,
                body: { code: "SSO_UNAVAILABLE" },
            });
            expect((await auth.$context).socialProviders).toEqual([]);
            idp.discovery[field] = value;
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(async () =>
                expect(
                    (await auth.$context).socialProviders.map((p) => p.id),
                ).toContain("oidc"),
            );
            expect(
                (await auth.api.signInSocial({ body: { provider: "oidc" } }))
                    .url,
            ).toContain("/protocol/openid-connect/auth?");
        } finally {
            vi.useRealTimers();
            idp.discovery[field] = value;
            resetAuthDiscoveryForTests();
            await auth.$context;
        }
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
