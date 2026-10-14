/**
 * Access management through the real API routes, against a real Keycloak,
 * with each administrator's own provider token:
 *
 * - only `use` + `access.manage` reach the routes (curators and users get
 *   403), same-origin JSON only;
 * - a change writes the managed group, reads the result back, audits the
 *   real actor and outcome, and refreshes or ends the person's sessions;
 * - stale screens, inherited capabilities and self-lockout are refused;
 * - the provider refusing the delegated change is its own error;
 * - two administrators removing each other end with one of them;
 * - losing `use` blocks the person's API keys at once, regaining it
 *   unblocks them.
 *
 * Opt-in: `TEST_DATABASE_URL` and `KEYCLOAK_TEST_ISSUER`.
 */

import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accessChangeLog,
    apiKeys,
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

const REALM = "chb-access-it";
const WEB_SECRET = "chatterbox-access-secret";
const VERIFIER_SECRET = "chatterbox-access-verifier-secret";

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
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-access-it`
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
            OIDC_CLIENT_SECRET: "chatterbox-access-secret",
            OIDC_PROVIDER_NAME: "Keycloak",
            OIDC_SCOPES: ["openid", "profile", "email"],
            OIDC_SESSION_MAX_AGE: 24 * 60 * 60,
            DISABLE_REGISTRATION: false,
            APP_URL: "http://localhost:3000",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            API_TOKEN_HASH_SECRET: undefined as string | undefined,
            DATABASE_URL: "postgres://unused",
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier" as
                | string
                | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET:
                "chatterbox-access-verifier-secret" as string | undefined,
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

import { POST as revokeRoute } from "@/app/api/access/subjects/[subject]/revoke-sessions/route";
import {
    PATCH as changeRoute,
    GET as detailRoute,
} from "@/app/api/access/subjects/[subject]/route";
import { GET as listRoute } from "@/app/api/access/subjects/route";
import { auth } from "@/lib/auth";
import {
    authenticateRequest,
    createApiKey,
    getApiKeyPrefix,
    hashApiKey,
} from "@/lib/auth-request";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && keycloakTestBase() ? describe : describe.skip;

interface Detail {
    subject: string;
    effective: string[];
    managed: string[];
    inherited: { capability: string; sources: string[] }[];
    revision: string;
    self: boolean;
}

describeWithKeycloak("access management (Keycloak)", () => {
    let database: TestPostgresDatabase | null = null;
    let realm: TestRealm;
    const cookies: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    function subject(username: string): string {
        const id = realm.people[username]?.id;
        if (!id) throw new Error(`no person ${username}`);
        return id;
    }

    function context(id: string) {
        return { params: Promise.resolve({ subject: id }) };
    }

    function get(as: string, path: string) {
        return new Request(`${TEST_APP_URL}${path}`, {
            headers: { cookie: cookies[as] ?? "" },
        });
    }

    function patch(
        as: string,
        target: string,
        body: unknown,
        headers: Record<string, string> = {},
    ) {
        return changeRoute(
            new Request(`${TEST_APP_URL}/api/access/subjects/${target}`, {
                method: "PATCH",
                headers: {
                    cookie: cookies[as] ?? "",
                    origin: TEST_APP_URL,
                    "content-type": "application/json",
                    ...headers,
                },
                body: JSON.stringify(body),
            }),
            context(target),
        );
    }

    async function detail(as: string, target: string): Promise<Detail> {
        const response = await detailRoute(
            get(as, `/api/access/subjects/${target}`),
            context(target),
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { access: Detail }).access;
    }

    async function groupsOf(username: string): Promise<string[]> {
        const groups = await realm.admin.http.get<{ id: string }[]>(
            adminPath`/users/${subject(username)}/groups`,
        );
        return groups.map((group) => group.id);
    }

    async function lastAudit(target: string) {
        const [row] = await db()
            .select()
            .from(accessChangeLog)
            .where(eq(accessChangeLog.targetSubject, target))
            .orderBy(desc(accessChangeLog.at))
            .limit(1);
        return row;
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

    async function recorderKey(username: string): Promise<string> {
        const raw = createApiKey();
        await db()
            .insert(apiKeys)
            .values({
                userId: await userId(username),
                name: "Meeting Recorder (test)",
                keyHash: hashApiKey(raw),
                keyPrefix: getApiKeyPrefix(raw),
                source: "recorder",
                scopes: ["recordings:write"],
            });
        return raw;
    }

    function withKey(key: string) {
        return new Request(`${TEST_APP_URL}/api/v1/recording-sessions`, {
            headers: { authorization: `Bearer ${key}` },
        });
    }

    beforeAll(async () => {
        realm = await provisionTestRealm(
            "access",
            {
                root: ["use", "access.manage"],
                second: ["use", "access.manage"],
                cora: ["use", "org.curate"],
                pat: ["use"],
                ina: ["use", "org.curate"],
                rex: ["use"],
                ada: ["use", "access.manage"],
                abe: ["use", "access.manage"],
                pam: ["use"],
            },
            {
                realmName: REALM,
                secrets: {
                    chatterbox: WEB_SECRET,
                    "chatterbox-verifier": VERIFIER_SECRET,
                },
            },
        );
        mockEnv.KEYCLOAK_GROUP_USE_ID = realm.groupIds.use;
        mockEnv.KEYCLOAK_GROUP_CURATE_ID = realm.groupIds["org.curate"];
        mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
            realm.groupIds["access.manage"];

        const { http } = realm.admin;
        const [web] = await http.get<{ id: string }[]>(adminPath`/clients`, {
            clientId: "chatterbox",
        });
        const webId = web?.id ?? "";
        const role = (name: string) =>
            http.get<{ id: string; name: string }>(
                adminPath`/clients/${webId}/roles/${name}`,
            );
        await http.post(
            adminPath`/users/${subject("ina")}/role-mappings/clients/${webId}`,
            [await role("org.curate")],
        );
        await http.post(
            adminPath`/users/${subject("pam")}/role-mappings/clients/${webId}`,
            [await role("access.manage")],
        );

        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "access_management",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await ensureOrgAccount();
        for (const username of Object.keys(realm.people)) {
            const person = realm.people[username];
            if (!person) continue;
            const { location, cookie } = await keycloakLogin(
                auth.handler,
                person,
            );
            expect(location).toBe("/dashboard");
            cookies[username] = cookie;
        }
    }, 240_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        await realm?.dispose();
    }, 60_000);

    it("lists people with their access for an administrator", async () => {
        const response = await listRoute(
            get("root", "/api/access/subjects?search=pat"),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            rows: {
                subject: string;
                effective: string[];
                managed: string[];
                local: { email: string } | null;
            }[];
        };
        expect(body.rows).toEqual([
            expect.objectContaining({
                subject: subject("pat"),
                effective: ["use"],
                managed: ["use"],
                local: expect.objectContaining({ email: "pat@example.test" }),
            }),
        ]);
        expect(JSON.stringify(body)).not.toMatch(/eyJ|secret|group/i);
    });

    it.each([
        "cora",
        "pat",
    ])("refuses %s, who does not manage access", async (as) => {
        const list = await listRoute(get(as, "/api/access/subjects"));
        expect(list.status).toBe(403);
        expect(await list.json()).toMatchObject({
            code: "CAPABILITY_REQUIRED",
        });
        const change = await patch(as, subject("pat"), {
            add: ["org.curate"],
            revision: "x",
        });
        expect(change.status).toBe(403);
        expect(await groupsOf("pat")).not.toContain(
            realm.groupIds["org.curate"],
        );
    });

    it("refuses a cross-site change", async () => {
        const response = await patch(
            "root",
            subject("pat"),
            { add: ["org.curate"], revision: "x" },
            { origin: "https://evil.example" },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
            error: "Cross-site request refused",
        });
    });

    it("refuses anything but catalog capabilities", async () => {
        for (const body of [
            { add: ["realm-admin"], revision: "x" },
            { add: ["use"], remove: ["use"], revision: "x" },
            { add: ["use"] },
            { add: ["use"], revision: "x", groupId: realm.groupIds.use },
        ]) {
            const response = await patch("root", subject("pat"), body);
            expect(response.status).toBe(400);
        }
    });

    it("makes someone a curator, reads it back, audits it and renews their sessions", async () => {
        const before = await detail("root", subject("pat"));
        expect(before.managed).toEqual(["use"]);
        const patId = await userId("pat");

        const response = await patch("root", subject("pat"), {
            add: ["org.curate"],
            revision: before.revision,
        });
        expect(response.status).toBe(200);
        const outcome = (await response.json()) as {
            status: string;
            revocation: string;
            correlationId: string;
            access: Detail;
        };
        expect(outcome.status).toBe("applied");
        expect(outcome.revocation).toBe("not-needed");
        expect(outcome.access.effective).toEqual(["use", "org.curate"]);
        expect(await groupsOf("pat")).toContain(realm.groupIds["org.curate"]);

        const audit = await lastAudit(subject("pat"));
        expect(audit).toMatchObject({
            correlationId: outcome.correlationId,
            actorSubject: subject("root"),
            actorUserId: await userId("root"),
            targetUserId: patId,
            outcome: "applied",
            requested: { add: ["org.curate"], remove: [] },
        });
        expect(JSON.stringify(audit)).not.toMatch(/eyJ/);

        const [credential] = await db()
            .select()
            .from(sessionIdpCredentials)
            .where(eq(sessionIdpCredentials.userId, patId));
        expect(credential?.verifiedAt.getTime()).toBe(0);
        const status = await auth.api.getSession({
            headers: new Headers({ cookie: cookies.pat ?? "" }),
        });
        expect(status).not.toBeNull();
        const { requireApiSessionActor } = await import("@/lib/auth-server");
        const { actor } = await requireApiSessionActor(get("pat", "/x"));
        expect([...actor.capabilities].sort()).toEqual(["org.curate", "use"]);
    });

    it("converges when the same change is asked again", async () => {
        const current = await detail("root", subject("pat"));
        const response = await patch("root", subject("pat"), {
            add: ["org.curate"],
            revision: current.revision,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "noop" });
    });

    it("refuses a change made against an older screen", async () => {
        const stale = await detail("root", subject("cora"));
        await realm.admin.http.delete(
            adminPath`/users/${subject("cora")}/groups/${realm.groupIds["org.curate"]}`,
        );
        try {
            const response = await patch("root", subject("cora"), {
                add: ["access.manage"],
                revision: stale.revision,
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({
                code: "ACCESS_STALE",
            });
            expect(await groupsOf("cora")).not.toContain(
                realm.groupIds["access.manage"],
            );
            expect((await lastAudit(subject("cora")))?.outcome).toBe("stale");
        } finally {
            await realm.admin.http.put(
                adminPath`/users/${subject("cora")}/groups/${realm.groupIds["org.curate"]}`,
            );
        }
    });

    it("explains an inherited capability instead of pretending to remove it", async () => {
        const access = await detail("root", subject("ina"));
        expect(access.managed).toEqual(["use", "org.curate"]);
        expect(access.inherited).toEqual([
            { capability: "org.curate", sources: ["direct-role"] },
        ]);
        const response = await patch("root", subject("ina"), {
            remove: ["org.curate"],
            revision: access.revision,
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: "ACCESS_INHERITED",
            details: {
                inherited: [
                    { capability: "org.curate", sources: ["direct-role"] },
                ],
            },
        });
        expect(await groupsOf("ina")).toContain(realm.groupIds["org.curate"]);
    });

    it.each([
        ["use"],
        ["access.manage"],
    ])("never lets an administrator take away their own %s", async (capability) => {
        const own = await detail("root", subject("root"));
        expect(own.self).toBe(true);
        const response = await patch("root", subject("root"), {
            remove: [capability],
            revision: own.revision,
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: "ACCESS_LOCKOUT",
        });
        expect(await groupsOf("root")).toContain(
            realm.groupIds["access.manage"],
        );
    });

    it("ends the sessions and blocks the keys of someone who loses use, and unblocks them again", async () => {
        const key = await recorderKey("rex");
        expect((await authenticateRequest(withKey(key)))?.user.id).toBe(
            await userId("rex"),
        );
        const rexId = await userId("rex");
        const before = await detail("root", subject("rex"));
        const response = await patch("root", subject("rex"), {
            remove: ["use"],
            revision: before.revision,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            status: "applied",
            revocation: "done",
            access: { effective: [] },
        });
        expect(
            await db()
                .select()
                .from(sessions)
                .where(eq(sessions.userId, rexId)),
        ).toEqual([]);
        const providerSessions = await realm.admin.http.get<unknown[]>(
            adminPath`/users/${subject("rex")}/sessions`,
        );
        expect(providerSessions).toEqual([]);
        await expect(authenticateRequest(withKey(key))).rejects.toMatchObject({
            code: "ACCESS_NOT_GRANTED",
            statusCode: 403,
        });
        expect(await lastAudit(subject("rex"))).toMatchObject({
            outcome: "applied",
            revocation: "done",
        });

        const again = await detail("root", subject("rex"));
        const restore = await patch("root", subject("rex"), {
            add: ["use"],
            revision: again.revision,
        });
        expect(restore.status).toBe(200);
        expect((await authenticateRequest(withKey(key)))?.user.id).toBe(rexId);
        const [state] = await db()
            .select()
            .from(userAccessStates)
            .where(eq(userAccessStates.userId, rexId));
        expect(state).toMatchObject({
            capabilities: ["use"],
            source: "access-change",
        });
    });

    it("reports the provider refusing a delegated change", async () => {
        const response = await listRoute(get("pam", "/api/access/subjects"));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
            code: "PROVIDER_DENIED",
        });

        const change = await patch("pam", subject("pat"), {
            remove: ["org.curate"],
            revision: "anything",
        });
        expect(change.status).toBe(403);
        expect(await change.json()).toMatchObject({ code: "PROVIDER_DENIED" });
        expect((await lastAudit(subject("pat")))?.outcome).toBe(
            "provider-denied",
        );
        expect(await groupsOf("pat")).toContain(realm.groupIds["org.curate"]);
    });

    it("leaves exactly one of two administrators who remove each other", async () => {
        const [one, two] = await Promise.all([
            detail("ada", subject("abe")),
            detail("abe", subject("ada")),
        ]);
        const [first, second] = await Promise.all([
            patch("ada", subject("abe"), {
                remove: ["access.manage"],
                revision: one.revision,
            }),
            patch("abe", subject("ada"), {
                remove: ["access.manage"],
                revision: two.revision,
            }),
        ]);
        const statuses = [first.status, second.status].sort();
        expect(statuses[0]).toBe(200);
        expect(statuses[1]).toBeGreaterThanOrEqual(400);
        const a1Admin = (await groupsOf("ada")).includes(
            realm.groupIds["access.manage"],
        );
        const a2Admin = (await groupsOf("abe")).includes(
            realm.groupIds["access.manage"],
        );
        expect([a1Admin, a2Admin].filter(Boolean)).toHaveLength(1);
    });

    it("asks for a fresh sign-in when the administrator authenticated too long ago", async () => {
        const rootId = await userId("root");
        await db()
            .update(sessionIdpCredentials)
            .set({ authTime: new Date(Date.now() - 9 * 3600 * 1000) })
            .where(eq(sessionIdpCredentials.userId, rootId));
        try {
            const access = await detail("root", subject("pat"));
            const response = await patch("root", subject("pat"), {
                remove: ["org.curate"],
                revision: access.revision,
            });
            expect(response.status).toBe(401);
            expect(await response.json()).toMatchObject({
                code: "REAUTHENTICATION_REQUIRED",
            });
            expect((await lastAudit(subject("pat")))?.outcome).toBe(
                "reauth-required",
            );
        } finally {
            await db()
                .update(sessionIdpCredentials)
                .set({ authTime: new Date() })
                .where(eq(sessionIdpCredentials.userId, rootId));
        }
    });

    it("ends someone's sessions on request and records it", async () => {
        const response = await revokeRoute(
            new Request(
                `${TEST_APP_URL}/api/access/subjects/${subject("cora")}/revoke-sessions`,
                {
                    method: "POST",
                    headers: {
                        cookie: cookies.second ?? "",
                        origin: TEST_APP_URL,
                        "content-type": "application/json",
                    },
                    body: "{}",
                },
            ),
            context(subject("cora")),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ revocation: "done" });
        expect(
            await db()
                .select()
                .from(sessions)
                .where(eq(sessions.userId, await userId("cora"))),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(accessChangeLog)
                .where(
                    and(
                        eq(accessChangeLog.targetSubject, subject("cora")),
                        eq(accessChangeLog.action, "revoke-sessions"),
                    ),
                ),
        ).toHaveLength(1);
    });
});
