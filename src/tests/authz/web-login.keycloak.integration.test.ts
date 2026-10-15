/**
 * Web sign-in with identity-provider authorization (AUTHZ_MODE=idp)
 * through a real Keycloak and the real better-auth callbacks:
 *
 * - who gets a session (`use` only, nobody else gets even an account),
 * - what is kept (the provider's tokens encrypted per session, never in
 *   `accounts`, never in a browser response),
 * - how a session stays valid (snapshot renewed with the refresh token,
 *   once under concurrency, ended on `invalid_grant` or lost `use`,
 *   refused but kept while the provider is down),
 * - issuer binding, logout cleanup and token verification.
 *
 * Opt-in: `TEST_DATABASE_URL` and `KEYCLOAK_TEST_ISSUER`.
 */

import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
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
    sessionIdpCredentials,
    sessions,
    userAccessStates,
    users,
} from "@/db/schema";
import { adminPath } from "@/lib/identity/providers/keycloak/http";
import { keycloakLogin } from "@/tests/authz/keycloak-login";
import {
    keycloakTestBase,
    provisionTestRealm,
    TEST_APP_URL,
    type TestRealm,
} from "@/tests/identity/keycloak-fixture";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const REALM = "chb-weblogin-it";
const WEB_SECRET = "chatterbox-weblogin-secret";

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
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-weblogin-it`
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
            OIDC_CLIENT_SECRET: "chatterbox-weblogin-secret",
            OIDC_PROVIDER_NAME: "Keycloak",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: false,
            APP_URL: "http://localhost:3000",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET: undefined as string | undefined,
            AUTHZ_VERIFICATION_MAX_AGE: 1800,
            AUTHZ_ADMIN_MAX_AUTH_AGE: 8 * 3600,
            MCP_AUDIENCE: undefined as string | undefined,
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
vi.mock("@/lib/hosted/billing/cycle-close", () => ({
    closeCycleForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendEmailChangeConfirm: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendVerifyEmail: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { authenticateRequest } from "@/lib/auth-request";
import { requireApiSessionActor } from "@/lib/auth-server";
import { recordAccessState } from "@/lib/authz/access-state";
import { runInAuthRequest } from "@/lib/authz/login-grant";
import { sessionAccess } from "@/lib/authz/session-access";
import { decryptText } from "@/lib/encryption/fields";
import { ensureOrgAccount } from "@/lib/org/account";
import { verifySsoLogin } from "@/lib/sso/auth-hooks";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && keycloakTestBase() ? describe : describe.skip;

describeWithKeycloak("web sign-in with identity-provider authorization", () => {
    let database: TestPostgresDatabase | null = null;
    let realm: TestRealm;
    const realFetch = globalThis.fetch;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function userByEmail(email: string) {
        const [row] = await db()
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        return row ?? null;
    }

    async function credentialOf(userId: string) {
        return db()
            .select()
            .from(sessionIdpCredentials)
            .where(eq(sessionIdpCredentials.userId, userId));
    }

    async function login(username: string) {
        const person = realm.people[username];
        if (!person) throw new Error(`no person ${username}`);
        return keycloakLogin(auth.handler, person);
    }

    function apiRequest(
        cookie: string,
        path = "/api/settings/recorder/status",
    ) {
        return new Request(`${TEST_APP_URL}${path}`, {
            headers: { cookie },
        });
    }

    async function sessionOf(cookie: string) {
        const found = await auth.api.getSession({
            headers: new Headers({ cookie }),
        });
        if (!found) throw new Error("no session");
        return { id: found.session.id, userId: found.user.id };
    }

    async function makeStale(userId: string) {
        await db()
            .update(sessionIdpCredentials)
            .set({ verifiedAt: new Date(Date.now() - 2 * 3600 * 1000) })
            .where(eq(sessionIdpCredentials.userId, userId));
    }

    beforeAll(async () => {
        realm = await provisionTestRealm(
            "weblogin",
            {
                ann: ["use"],
                cora: ["use", "org.curate"],
                adam: ["use", "access.manage"],
                nora: [],
                ivan: ["use"],
                dora: ["use"],
                leo: ["use"],
                race: ["use"],
                late: ["use"],
            },
            { realmName: REALM, secrets: { chatterbox: WEB_SECRET } },
        );
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "authz_weblogin",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await ensureOrgAccount();
    }, 180_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        dbRef.current = null;
        await database?.dispose();
        await realm?.dispose();
    }, 60_000);

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("signs a person with use in and keeps the provider's tokens encrypted per session", async () => {
        const { location, cookie } = await login("ann");
        expect(location).toBe("/dashboard");
        const ann = await userByEmail("ann@example.test");
        expect(ann).not.toBeNull();

        const [account] = await db()
            .select()
            .from(accounts)
            .where(
                and(
                    eq(accounts.userId, ann?.id ?? ""),
                    eq(accounts.providerId, "oidc"),
                ),
            );
        expect(account?.accountId).toBe(realm.people.ann?.id);
        expect(account?.issuer).toBe(realm.issuer);
        expect(account?.accessToken).toBeNull();
        expect(account?.refreshToken).toBeNull();
        expect(account?.idToken).toBeNull();

        const [credential] = await credentialOf(ann?.id ?? "");
        expect(credential?.capabilities).toEqual(["use"]);
        expect(credential?.subject).toBe(realm.people.ann?.id);
        expect(credential?.accessToken).toMatch(/^v1:/);
        expect(credential?.refreshToken).toMatch(/^v1:/);
        const accessToken = decryptText(credential?.accessToken ?? "");
        expect(decodeJwt(accessToken).azp).toBe("chatterbox");
        const session = await sessionOf(cookie);
        expect(credential?.sessionId).toBe(session.id);

        const [state] = await db()
            .select()
            .from(userAccessStates)
            .where(eq(userAccessStates.userId, ann?.id ?? ""));
        expect(state?.capabilities).toEqual(["use"]);
        expect(state?.source).toBe("login");

        const getSession = await auth.handler(
            new Request(`${TEST_APP_URL}/api/auth/get-session`, {
                headers: { cookie },
            }),
        );
        const text = await getSession.text();
        expect(text).toContain("ann@example.test");
        expect(text).not.toContain(accessToken);
        expect(text).not.toContain(accessToken.split(".")[1] ?? "x");
        expect(text).not.toContain(
            decryptText(credential?.refreshToken ?? "") ?? "x",
        );
        expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    });

    it.each([
        "/api/auth/get-access-token",
        "/api/auth/refresh-token",
        "/api/auth/account-info",
    ])("switches off %s", async (path) => {
        const { cookie } = await login("ann");
        const response = await auth.handler(
            new Request(`${TEST_APP_URL}${path}`, {
                method: "POST",
                headers: {
                    cookie,
                    "content-type": "application/json",
                    origin: TEST_APP_URL,
                },
                body: JSON.stringify({ providerId: "oidc" }),
            }),
        );
        expect(response.status).toBe(404);
    });

    it("refuses a person without use before creating anything", async () => {
        const { location, cookie } = await login("nora");
        expect(location).toBe(
            "http://localhost:3000/login?error=SSO_ACCESS_DENIED",
        );
        expect(cookie).not.toContain("session_token");
        expect(await userByEmail("nora@example.test")).toBeNull();
    });

    it("stores the capabilities of curators and administrators", async () => {
        await login("cora");
        await login("adam");
        const cora = await userByEmail("cora@example.test");
        const adam = await userByEmail("adam@example.test");
        expect((await credentialOf(cora?.id ?? ""))[0]?.capabilities).toEqual([
            "use",
            "org.curate",
        ]);
        expect((await credentialOf(adam?.id ?? ""))[0]?.capabilities).toEqual([
            "use",
            "access.manage",
        ]);
    });

    it("renews a stale snapshot once, however many requests race", async () => {
        const { cookie } = await login("ivan");
        const session = await sessionOf(cookie);
        const [before] = await credentialOf(session.userId);
        await makeStale(session.userId);

        let tokenCalls = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input, init) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.endsWith("/protocol/openid-connect/token"))
                    tokenCalls++;
                return realFetch(input, init);
            },
        );
        const results = await Promise.all(
            Array.from({ length: 6 }, () => sessionAccess(session)),
        );
        expect(results.every((result) => result.ok)).toBe(true);
        expect(tokenCalls).toBe(1);

        const [after] = await credentialOf(session.userId);
        expect(after?.verifiedAt.getTime()).toBeGreaterThan(
            Date.now() - 60_000,
        );
        expect(decryptText(after?.accessToken ?? "")).not.toBe(
            decryptText(before?.accessToken ?? ""),
        );
    });

    it("does not let a delayed refresh overwrite a newer access change", async () => {
        const { cookie } = await login("race");
        const session = await sessionOf(cookie);
        await makeStale(session.userId);
        let reached!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input, init) => {
                const response = await realFetch(input, init);
                const url =
                    input instanceof Request ? input.url : String(input);
                if (!url.endsWith("/protocol/openid-connect/token"))
                    return response;
                const body = await response.text();
                reached();
                await barrier;
                return new Response(body, {
                    status: response.status,
                    headers: response.headers,
                });
            },
        );
        const pending = sessionAccess(session);
        try {
            await waiting;
            await recordAccessState({
                userId: session.userId,
                issuer: realm.issuer,
                subject: realm.people.race?.id ?? "",
                capabilities: [],
                source: "access-change",
            });
            release();
            expect(await pending).toEqual({ ok: false, reason: "unavailable" });
            const [state] = await db()
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, session.userId));
            expect(state).toMatchObject({
                capabilities: [],
                source: "access-change",
            });
            const [credential] = await credentialOf(session.userId);
            expect(credential?.verifiedAt.getTime()).toBe(0);
        } finally {
            release();
            await pending;
        }
    });

    it("does not let a delayed sign-in overwrite a newer access change", async () => {
        await login("late");
        const user = await userByEmail("late@example.test");
        if (!user) throw new Error("missing user");
        let reached!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input, init) => {
                const response = await realFetch(input, init);
                const url =
                    input instanceof Request ? input.url : String(input);
                if (!url.endsWith("/protocol/openid-connect/token"))
                    return response;
                const body = await response.text();
                reached();
                await barrier;
                return new Response(body, {
                    status: response.status,
                    headers: response.headers,
                });
            },
        );
        const pending = login("late");
        try {
            await waiting;
            await recordAccessState({
                userId: user.id,
                issuer: realm.issuer,
                subject: realm.people.late?.id ?? "",
                capabilities: [],
                source: "access-change",
            });
            release();
            const result = await pending;
            expect(result.location).toContain("SSO_UNAVAILABLE");
            expect(result.cookie).not.toContain("session_token");
            const [state] = await db()
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, user.id));
            expect(state).toMatchObject({
                capabilities: [],
                source: "access-change",
            });
            expect(await credentialOf(user.id)).toHaveLength(1);
        } finally {
            release();
            await pending;
        }
    });

    it("requests fresh authentication only for the explicit reauthentication path", async () => {
        for (const reauthenticate of [false, true]) {
            const response = await auth.handler(
                new Request(`${TEST_APP_URL}/api/auth/sign-in/oauth2`, {
                    method: "POST",
                    headers: {
                        origin: TEST_APP_URL,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        providerId: "oidc",
                        callbackURL: "/settings#access",
                        additionalData: { reauthenticate },
                    }),
                }),
            );
            expect(response.status).toBe(200);
            const { url } = (await response.json()) as { url: string };
            const params = new URL(url).searchParams;
            expect(params.get("max_age")).toBe(reauthenticate ? "0" : null);
            expect(params.get("prompt")).toBe(reauthenticate ? "login" : null);
        }
    });

    it("refuses but keeps a session while the provider cannot be reached", async () => {
        const { cookie } = await login("dora");
        const session = await sessionOf(cookie);
        await makeStale(session.userId);
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input, init) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.startsWith(realm.issuer)) {
                    throw new TypeError("fetch failed");
                }
                return realFetch(input, init);
            },
        );
        await expect(
            requireApiSessionActor(apiRequest(cookie)),
        ).rejects.toMatchObject({
            code: "ACCESS_UNVERIFIABLE",
            statusCode: 503,
        });
        const browserSession = await auth.handler(
            apiRequest(cookie, "/api/auth/get-session"),
        );
        expect(browserSession.status).toBe(503);
        expect(browserSession.headers.get("Retry-After")).toBe("30");
        expect(
            await db()
                .select()
                .from(sessions)
                .where(eq(sessions.id, session.id)),
        ).toHaveLength(1);

        vi.restoreAllMocks();
        const { actor } = await requireApiSessionActor(apiRequest(cookie));
        expect([...actor.capabilities]).toEqual(["use"]);
    });

    it("ends a session the provider ended (invalid_grant)", async () => {
        const { cookie } = await login("leo");
        const session = await sessionOf(cookie);
        await realm.admin.http.post(
            adminPath`/users/${realm.people.leo?.id ?? ""}/logout`,
        );
        await makeStale(session.userId);
        await expect(
            requireApiSessionActor(apiRequest(cookie)),
        ).rejects.toMatchObject({
            code: "AUTH_SESSION_MISSING",
            statusCode: 401,
        });
        expect(
            await db()
                .select()
                .from(sessions)
                .where(eq(sessions.id, session.id)),
        ).toEqual([]);
        expect(await credentialOf(session.userId)).toEqual([]);
    });

    it("ends the session of a person who lost use at the provider", async () => {
        const { cookie } = await login("ivan");
        const session = await sessionOf(cookie);
        const ivan = realm.people.ivan?.id ?? "";
        await realm.admin.http.delete(
            adminPath`/users/${ivan}/groups/${realm.groupIds.use}`,
        );
        try {
            await makeStale(session.userId);
            await expect(
                requireApiSessionActor(apiRequest(cookie)),
            ).rejects.toMatchObject({
                code: "ACCESS_NOT_GRANTED",
                statusCode: 403,
            });
            expect(
                await db()
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, session.id)),
            ).toEqual([]);
            const [state] = await db()
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, session.userId));
            expect(state?.capabilities).toEqual([]);
            const getSession = await auth.handler(
                new Request(`${TEST_APP_URL}/api/auth/get-session`, {
                    headers: { cookie },
                }),
            );
            expect(await getSession.json()).toBeNull();
        } finally {
            await realm.admin.http.put(
                adminPath`/users/${ivan}/groups/${realm.groupIds.use}`,
            );
        }
    });

    it("applies the same checks to API requests authenticated by session", async () => {
        const { cookie } = await login("ann");
        const session = await sessionOf(cookie);
        await db()
            .delete(sessionIdpCredentials)
            .where(eq(sessionIdpCredentials.sessionId, session.id));
        await expect(
            authenticateRequest(apiRequest(cookie)),
        ).rejects.toMatchObject({
            statusCode: 401,
        });
        expect(
            await db()
                .select()
                .from(sessions)
                .where(eq(sessions.id, session.id)),
        ).toEqual([]);
    });

    it("deletes the credential with the session on sign-out", async () => {
        const { cookie } = await login("ann");
        const session = await sessionOf(cookie);
        expect(
            await db()
                .select()
                .from(sessionIdpCredentials)
                .where(eq(sessionIdpCredentials.sessionId, session.id)),
        ).toHaveLength(1);
        const out = await auth.handler(
            new Request(`${TEST_APP_URL}/api/auth/sign-out`, {
                method: "POST",
                headers: {
                    cookie,
                    origin: TEST_APP_URL,
                    "content-type": "application/json",
                },
                body: "{}",
            }),
        );
        expect(out.status).toBe(200);
        expect(
            await db()
                .select()
                .from(sessionIdpCredentials)
                .where(eq(sessionIdpCredentials.sessionId, session.id)),
        ).toEqual([]);
    });

    it("refuses a sign-in for an account bound to another issuer", async () => {
        const ann = await userByEmail("ann@example.test");
        await db()
            .update(accounts)
            .set({ issuer: "https://other.example/realms/x" })
            .where(eq(accounts.userId, ann?.id ?? ""));
        try {
            const { location } = await login("ann");
            expect(location).toMatch(
                /^\/login\?error=SSO_ISSUER_MISMATCH(&|$)/,
            );
        } finally {
            await db()
                .update(accounts)
                .set({ issuer: realm.issuer })
                .where(eq(accounts.userId, ann?.id ?? ""));
        }
    });

    describe("token verification", () => {
        async function refusal(tokens: {
            accessToken?: string;
            idToken?: string;
        }): Promise<string> {
            try {
                await runInAuthRequest(() =>
                    verifySsoLogin({
                        tokenType: "Bearer",
                        accessToken: tokens.accessToken,
                        idToken: tokens.idToken,
                    }),
                );
            } catch (error) {
                const headers = (error as { headers?: Record<string, string> })
                    .headers;
                return headers?.location ?? String(error);
            }
            return "accepted";
        }

        it("accepts the web client's own tokens", async () => {
            const tokens = await realm.passwordToken(
                "chatterbox",
                realm.people.ann ?? (undefined as never),
            );
            expect(
                await refusal({
                    accessToken: tokens.access_token,
                    idToken: tokens.id_token,
                }),
            ).toBe("accepted");
        });

        it("refuses an ID token issued to another client", async () => {
            const own = await realm.passwordToken(
                "chatterbox",
                realm.people.ann ?? (undefined as never),
            );
            const other = await realm.passwordToken(
                "mcp-tester",
                realm.people.ann ?? (undefined as never),
            );
            expect(
                await refusal({
                    accessToken: own.access_token,
                    idToken: other.id_token,
                }),
            ).toContain("error=SSO_TOKEN_INVALID");
            expect(
                await refusal({
                    accessToken: other.access_token,
                    idToken: own.id_token,
                }),
            ).toContain("error=SSO_TOKEN_INVALID");
        });

        it("refuses an access token in place of the ID token, and a forged signature", async () => {
            const own = await realm.passwordToken(
                "chatterbox",
                realm.people.ann ?? (undefined as never),
            );
            expect(
                await refusal({
                    accessToken: own.access_token,
                    idToken: own.access_token,
                }),
            ).toContain("error=SSO_TOKEN_INVALID");
            const [header, payload] = (own.id_token ?? "").split(".");
            expect(
                await refusal({
                    accessToken: own.access_token,
                    idToken: `${header}.${payload}.AAAA`,
                }),
            ).toContain("error=SSO_TOKEN_INVALID");
            const unsigned = [
                Buffer.from(JSON.stringify({ alg: "none" })).toString(
                    "base64url",
                ),
                payload,
                "",
            ].join(".");
            expect(
                await refusal({
                    accessToken: own.access_token,
                    idToken: unsigned,
                }),
            ).toContain("error=SSO_TOKEN_INVALID");
        });

        it("refuses tokens of two different people", async () => {
            const ann = await realm.passwordToken(
                "chatterbox",
                realm.people.ann ?? (undefined as never),
            );
            const cora = await realm.passwordToken(
                "chatterbox",
                realm.people.cora ?? (undefined as never),
            );
            expect(
                await refusal({
                    accessToken: cora.access_token,
                    idToken: ann.id_token,
                }),
            ).toContain("error=SSO_TOKEN_INVALID");
        });
    });
});
