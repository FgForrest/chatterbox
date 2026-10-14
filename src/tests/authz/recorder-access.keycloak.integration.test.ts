/**
 * The meeting recorder's key under identity-provider authorization,
 * through the real routes and a real Keycloak:
 *
 * - pairing from a signed-in session, then streaming encrypted chunks;
 * - resuming after an interruption (re-sent chunks are idempotent, the
 *   session lists what arrived);
 * - access withdrawn mid-recording blocks the key at once (403) while the
 *   server keeps what arrived, and giving it back lets the same key finish;
 * - the holder's access is re-verified by the access verifier, not by the
 *   holder's web sign-in: a disabled or deleted person is refused, an
 *   unreachable provider or a missing verifier is a retryable 503;
 * - a re-paired extension rebinds the unfinished capture to its new key.
 *
 * Opt-in: `TEST_DATABASE_URL` and `KEYCLOAK_TEST_ISSUER`.
 */

import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordingSessionChunks, userAccessStates, users } from "@/db/schema";
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

const REALM = "chb-recorder-it";

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
        ? `${new URL(process.env.KEYCLOAK_TEST_ISSUER).origin}/realms/chb-recorder-it`
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
            OIDC_CLIENT_SECRET: "chatterbox-recorder-secret",
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
            DEFAULT_STORAGE_TYPE: "local" as const,
            LOCAL_STORAGE_PATH: "",
            RATE_LIMIT_TRUST_PROXY_HEADERS: undefined as boolean | undefined,
            RECORDER_AUTO_RECORD_PLATFORMS: [] as string[],
            RECORDER_AUTO_STOP_QUIET_SECONDS: 120,
            RECORDER_NOTICE_TEXT: undefined as string | undefined,
            RECORDER_LOCK_DEFAULTS: undefined as boolean | undefined,
            AUTHZ_MODE: "idp" as "idp" | "local",
            IDENTITY_PROVIDER: "keycloak" as const,
            KEYCLOAK_ROLES_CLIENT: undefined as string | undefined,
            KEYCLOAK_GROUP_USE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_CURATE_ID: undefined as string | undefined,
            KEYCLOAK_GROUP_ACCESS_MANAGE_ID: undefined as string | undefined,
            KEYCLOAK_VERIFIER_CLIENT_ID: "chatterbox-verifier" as
                | string
                | undefined,
            KEYCLOAK_VERIFIER_CLIENT_SECRET: "chatterbox-recorder-verifier" as
                | string
                | undefined,
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import {
    GET as accessDetailRoute,
    PATCH as changeAccessRoute,
} from "@/app/api/access/subjects/[subject]/route";
import { POST as pairRoute } from "@/app/api/settings/recorder/pair/route";
import { POST as rebindRoute } from "@/app/api/settings/recorder/rebind/route";
import { PUT as chunkRoute } from "@/app/api/v1/recording-sessions/[id]/chunks/[index]/route";
import { POST as completeRoute } from "@/app/api/v1/recording-sessions/[id]/complete/route";
import { GET as sessionRoute } from "@/app/api/v1/recording-sessions/[id]/route";
import { POST as createSessionRoute } from "@/app/api/v1/recording-sessions/route";
import { auth } from "@/lib/auth";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithKeycloak =
    testDatabaseUrl && keycloakTestBase() ? describe : describe.skip;

interface Capture {
    sessionId: string;
    clientRecordingId: string;
    key: Buffer;
}

function encryptChunk(capture: Capture, index: number, data: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", capture.key, nonce);
    cipher.setAAD(
        Buffer.from(
            `chatterbox-recorder-v1:${capture.clientRecordingId}:${index}`,
        ),
    );
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, body, cipher.getAuthTag()]);
}

describeWithKeycloak(
    "the recorder under identity-provider authorization",
    () => {
        let database: TestPostgresDatabase | null = null;
        let realm: TestRealm;
        let storageRoot = "";
        const cookies: Record<string, string> = {};
        const realFetch = globalThis.fetch;

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
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

        function subject(username: string): string {
            return realm.people[username]?.id ?? "";
        }

        async function login(username: string) {
            const person = realm.people[username];
            if (!person) throw new Error(`no person ${username}`);
            const { location, cookie } = await keycloakLogin(
                auth.handler,
                person,
            );
            expect(location).toBe("/dashboard");
            cookies[username] = cookie;
        }

        async function pair(
            username: string,
        ): Promise<{ key: string; id: string }> {
            const response = await pairRoute(
                new Request(`${TEST_APP_URL}/api/settings/recorder/pair`, {
                    method: "POST",
                    headers: {
                        cookie: cookies[username] ?? "",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        label: "test",
                        installationId: randomUUID(),
                    }),
                }),
            );
            expect(response.status).toBe(201);
            const body = (await response.json()) as {
                api_key: string;
                key_id: string;
            };
            return { key: body.api_key, id: body.key_id };
        }

        async function startCapture(key: string): Promise<Capture> {
            const clientRecordingId = randomUUID();
            const response = await createSessionRoute(
                new Request(`${TEST_APP_URL}/api/v1/recording-sessions`, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${key}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        clientRecordingId,
                        mimeType: "audio/webm",
                        channelLayout: ["mic"],
                        startedAt: new Date().toISOString(),
                    }),
                }),
            );
            expect(response.status).toBe(201);
            const body = (await response.json()) as {
                id: string;
                encryption: { key: string };
            };
            return {
                sessionId: body.id,
                clientRecordingId,
                key: Buffer.from(body.encryption.key, "base64"),
            };
        }

        async function upload(key: string, capture: Capture, index: number) {
            const envelope = encryptChunk(
                capture,
                index,
                Buffer.from(`chunk-${index}-${"x".repeat(64)}`),
            );
            const { createHash } = await import("node:crypto");
            return chunkRoute(
                new Request(
                    `${TEST_APP_URL}/api/v1/recording-sessions/${capture.sessionId}/chunks/${index}`,
                    {
                        method: "PUT",
                        headers: {
                            authorization: `Bearer ${key}`,
                            "content-type": "application/octet-stream",
                            "x-chunk-sha256": createHash("sha256")
                                .update(envelope)
                                .digest("hex"),
                        },
                        body: new Uint8Array(envelope),
                    },
                ),
                {
                    params: Promise.resolve({
                        id: capture.sessionId,
                        index: String(index),
                    }),
                },
            );
        }

        async function received(key: string, capture: Capture) {
            const response = await sessionRoute(
                new Request(
                    `${TEST_APP_URL}/api/v1/recording-sessions/${capture.sessionId}`,
                    { headers: { authorization: `Bearer ${key}` } },
                ),
                { params: Promise.resolve({ id: capture.sessionId }) },
            );
            expect(response.status).toBe(200);
            return ((await response.json()) as { received_chunks: number[] })
                .received_chunks;
        }

        async function makeStale(username: string) {
            await db()
                .update(userAccessStates)
                .set({ verifiedAt: new Date(Date.now() - 2 * 3600 * 1000) })
                .where(eq(userAccessStates.userId, await userId(username)));
        }

        async function changeAccess(target: string, body: object) {
            const params = {
                params: Promise.resolve({ subject: subject(target) }),
            };
            const detail = await accessDetailRoute(
                new Request(
                    `${TEST_APP_URL}/api/access/subjects/${subject(target)}`,
                    {
                        headers: { cookie: cookies.boss ?? "" },
                    },
                ),
                params,
            );
            const { access } = (await detail.json()) as {
                access: { revision: string };
            };
            const response = await changeAccessRoute(
                new Request(
                    `${TEST_APP_URL}/api/access/subjects/${subject(target)}`,
                    {
                        method: "PATCH",
                        headers: {
                            cookie: cookies.boss ?? "",
                            origin: TEST_APP_URL,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            ...body,
                            revision: access.revision,
                        }),
                    },
                ),
                params,
            );
            expect(response.status).toBe(200);
        }

        beforeAll(async () => {
            storageRoot = await mkdtemp(join(tmpdir(), "chb-recorder-"));
            mockEnv.LOCAL_STORAGE_PATH = storageRoot;
            realm = await provisionTestRealm(
                "recorder",
                {
                    boss: ["use", "access.manage"],
                    rita: ["use"],
                    dan: ["use"],
                    del: ["use"],
                    vic: ["use"],
                    race: ["use"],
                },
                {
                    realmName: REALM,
                    secrets: {
                        chatterbox: "chatterbox-recorder-secret",
                        "chatterbox-verifier": "chatterbox-recorder-verifier",
                    },
                },
            );
            mockEnv.KEYCLOAK_GROUP_USE_ID = realm.groupIds.use;
            mockEnv.KEYCLOAK_GROUP_CURATE_ID = realm.groupIds["org.curate"];
            mockEnv.KEYCLOAK_GROUP_ACCESS_MANAGE_ID =
                realm.groupIds["access.manage"];
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "recorder_access",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await ensureOrgAccount();
            for (const username of Object.keys(realm.people))
                await login(username);
        }, 240_000);

        afterAll(async () => {
            vi.restoreAllMocks();
            dbRef.current = null;
            await database?.dispose();
            await realm?.dispose();
            if (storageRoot)
                await rm(storageRoot, { recursive: true, force: true });
        }, 60_000);

        it("pairs, streams, survives an interruption, blocks on withdrawal and finishes after restoration", async () => {
            const { key } = await pair("rita");
            const capture = await startCapture(key);
            expect((await upload(key, capture, 0)).status).toBe(201);
            expect((await upload(key, capture, 1)).status).toBe(201);

            const retried = await upload(key, capture, 1);
            expect(retried.status).toBe(200);
            expect(await retried.json()).toMatchObject({ duplicate: true });
            expect(await received(key, capture)).toEqual([0, 1]);

            await changeAccess("rita", { remove: ["use"] });
            const refused = await upload(key, capture, 2);
            expect(refused.status).toBe(403);
            expect(await refused.json()).toMatchObject({
                code: "ACCESS_NOT_GRANTED",
            });
            const kept = await db()
                .select({ index: recordingSessionChunks.index })
                .from(recordingSessionChunks)
                .where(eq(recordingSessionChunks.sessionId, capture.sessionId));
            expect(kept.map((chunk) => chunk.index).sort()).toEqual([0, 1]);

            await changeAccess("rita", { add: ["use"] });
            expect(await received(key, capture)).toEqual([0, 1]);
            expect((await upload(key, capture, 2)).status).toBe(201);
            const complete = await completeRoute(
                new Request(
                    `${TEST_APP_URL}/api/v1/recording-sessions/${capture.sessionId}/complete`,
                    {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${key}`,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            chunkCount: 3,
                            endedAt: new Date().toISOString(),
                            stopReason: "user",
                        }),
                    },
                ),
                { params: Promise.resolve({ id: capture.sessionId }) },
            );
            expect(complete.status).toBeLessThan(300);
        });

        it("keeps the key working past the verification age without a web sign-in", async () => {
            const { key } = await pair("dan");
            const capture = await startCapture(key);
            await makeStale("dan");
            let verifierCalls = 0;
            vi.spyOn(globalThis, "fetch").mockImplementation(
                async (input, init) => {
                    const url =
                        typeof input === "string"
                            ? input
                            : input instanceof URL
                              ? input.href
                              : input.url;
                    if (url.includes(`/admin/realms/${REALM}/users/`))
                        verifierCalls++;
                    return realFetch(input, init);
                },
            );
            try {
                expect((await upload(key, capture, 0)).status).toBe(201);
                expect(verifierCalls).toBeGreaterThan(0);
                const [state] = await db()
                    .select()
                    .from(userAccessStates)
                    .where(eq(userAccessStates.userId, await userId("dan")));
                expect(state?.source).toBe("verifier");
                expect(state?.verifiedAt.getTime()).toBeGreaterThan(
                    Date.now() - 60_000,
                );
            } finally {
                vi.restoreAllMocks();
            }
        });

        it("does not resurrect use when an older verifier response arrives after revocation", async () => {
            const { key } = await pair("race");
            const capture = await startCapture(key);
            await makeStale("race");
            let release!: () => void;
            let observed!: () => void;
            const paused = new Promise<void>((resolve) => {
                observed = resolve;
            });
            const resume = new Promise<void>((resolve) => {
                release = resolve;
            });
            let intercepted = false;
            vi.spyOn(globalThis, "fetch").mockImplementation(
                async (input, init) => {
                    const url = String(input);
                    const response = await realFetch(input, init);
                    if (
                        !intercepted &&
                        url.includes(
                            `/users/${subject("race")}/role-mappings/clients/`,
                        ) &&
                        url.endsWith("/composite")
                    ) {
                        intercepted = true;
                        const body = await response.text();
                        observed();
                        await resume;
                        return new Response(body, {
                            status: response.status,
                            headers: response.headers,
                        });
                    }
                    return response;
                },
            );
            const pending = upload(key, capture, 0);
            try {
                await paused;
                await changeAccess("race", { remove: ["use"] });
                release();
                expect((await pending).status).toBe(503);
                expect((await upload(key, capture, 0)).status).toBe(403);
                const [state] = await db()
                    .select()
                    .from(userAccessStates)
                    .where(eq(userAccessStates.userId, await userId("race")));
                expect(state?.source).toBe("access-change");
                expect(state?.capabilities).not.toContain("use");
            } finally {
                release();
                await pending;
                vi.restoreAllMocks();
            }
        }, 30_000);

        it("answers 503 while the provider cannot be asked, and resumes after", async () => {
            const { key } = await pair("vic");
            const capture = await startCapture(key);
            await makeStale("vic");
            vi.spyOn(globalThis, "fetch").mockImplementation(
                async (input, init) => {
                    const url =
                        typeof input === "string"
                            ? input
                            : input instanceof URL
                              ? input.href
                              : input.url;
                    if (url.startsWith(keycloakTestBase() ?? "")) {
                        throw new TypeError("fetch failed");
                    }
                    return realFetch(input, init);
                },
            );
            try {
                const unavailable = await upload(key, capture, 0);
                expect(unavailable.status).toBe(503);
                expect(await unavailable.json()).toMatchObject({
                    code: "ACCESS_UNVERIFIABLE",
                });
            } finally {
                vi.restoreAllMocks();
            }
            expect((await upload(key, capture, 0)).status).toBe(201);
        });

        it("answers 503 without a verifier until a web sign-in renews the verification", async () => {
            const { key } = await pair("vic");
            const capture = await startCapture(key);
            await makeStale("vic");
            mockEnv.KEYCLOAK_VERIFIER_CLIENT_ID = undefined;
            mockEnv.KEYCLOAK_VERIFIER_CLIENT_SECRET = undefined;
            try {
                expect((await upload(key, capture, 0)).status).toBe(503);
                await login("vic");
                expect((await upload(key, capture, 0)).status).toBe(201);
            } finally {
                mockEnv.KEYCLOAK_VERIFIER_CLIENT_ID = "chatterbox-verifier";
                mockEnv.KEYCLOAK_VERIFIER_CLIENT_SECRET =
                    "chatterbox-recorder-verifier";
            }
        });

        it("refuses the key of someone disabled at the provider, and of someone deleted there", async () => {
            const { key } = await pair("dan");
            const capture = await startCapture(key);
            await realm.admin.http.put(adminPath`/users/${subject("dan")}`, {
                enabled: false,
            });
            await makeStale("dan");
            const disabled = await upload(key, capture, 0);
            expect(disabled.status).toBe(403);
            expect(await disabled.json()).toMatchObject({
                code: "ACCESS_NOT_GRANTED",
            });
            await realm.admin.http.put(adminPath`/users/${subject("dan")}`, {
                enabled: true,
            });
            await makeStale("dan");
            expect((await upload(key, capture, 0)).status).toBe(201);

            const removed = await pair("del");
            const delCapture = await startCapture(removed.key);
            await realm.admin.http.delete(adminPath`/users/${subject("del")}`);
            await makeStale("del");
            const gone = await upload(removed.key, delCapture, 0);
            expect(gone.status).toBe(403);
            const [state] = await db()
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, await userId("del")));
            expect(state?.status).toBe("missing");
        });

        it("rebinds an unfinished capture to the key of a new pairing after signing in again", async () => {
            // Withdrawing `use` above ended Rita's sessions; pairing needs a new sign-in.
            const ended = await pairRoute(
                new Request(`${TEST_APP_URL}/api/settings/recorder/pair`, {
                    method: "POST",
                    headers: {
                        cookie: cookies.rita ?? "",
                        "content-type": "application/json",
                    },
                    body: "{}",
                }),
            );
            expect(ended.status).toBe(401);
            await login("rita");
            const first = await pair("rita");
            const capture = await startCapture(first.key);
            expect((await upload(first.key, capture, 0)).status).toBe(201);

            const second = await pair("rita");
            const rebind = await rebindRoute(
                new Request(`${TEST_APP_URL}/api/settings/recorder/rebind`, {
                    method: "POST",
                    headers: {
                        cookie: cookies.rita ?? "",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        clientRecordingId: capture.clientRecordingId,
                        apiKeyId: second.id,
                    }),
                }),
            );
            expect(rebind.status).toBe(200);
            expect((await upload(second.key, capture, 1)).status).toBe(201);
            expect(await received(second.key, capture)).toEqual([0, 1]);
        });
    },
);
