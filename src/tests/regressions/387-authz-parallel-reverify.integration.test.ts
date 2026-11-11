import { setTimeout } from "node:timers/promises";
import { eq } from "drizzle-orm";
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
import { accounts, apiKeys, userAccessStates, users } from "@/db/schema";
import { authenticateRequest, hashApiKey } from "@/lib/auth-request";
import { holderAccess, recordAccessState } from "@/lib/authz/access-state";
import type { Capability } from "@/lib/authz/catalog";
import type { AccessVerifierPort } from "@/lib/identity/ports";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, dbProxy, verify } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_, property) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        verify: vi.fn<AccessVerifierPort["verify"]>(),
    };
});

vi.mock("@/db", () => ({ db: dbProxy }));
vi.mock("@/lib/env", () => ({
    env: {
        AUTHZ_VERIFICATION_MAX_AGE: 1800,
        BETTER_AUTH_SECRET: "parallel-reverify-test-secret",
    },
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => true,
    getAccessVerifier: () => ({ verify }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/lib/auth-server", () => ({ sessionRefusalError: vi.fn() }));

const url = getTestDatabaseUrl();
const USER_ID = "parallel-holder";
const ISSUER = "https://identity.example.test";
const SUBJECT = "parallel-subject";
const KEY = "op_parallelReverificationTestKey";
const REQUESTS = 6;

describe.skipIf(!url)("parallel holder re-verification (issue #387)", () => {
    let database: TestPostgresDatabase;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "authz_parallel",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await database.db
            .insert(users)
            .values({ id: USER_ID, email: "holder@example.test" });
        await database.db.insert(accounts).values({
            userId: USER_ID,
            providerId: SSO_PROVIDER_ID,
            accountId: SUBJECT,
            issuer: ISSUER,
        });
        await database.db.insert(apiKeys).values({
            id: "parallel-key",
            userId: USER_ID,
            name: "Test key",
            keyHash: hashApiKey(KEY),
            keyPrefix: KEY.slice(0, 12),
            scopes: ["recordings:write"],
        });
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        verify.mockReset();
        await database.db
            .delete(userAccessStates)
            .where(eq(userAccessStates.userId, USER_ID));
        const stale = new Date(Date.now() - 3600_000);
        await database.db.insert(userAccessStates).values({
            userId: USER_ID,
            issuer: ISSUER,
            subject: SUBJECT,
            capabilities: ["use"],
            status: "active",
            source: "login",
            verifiedAt: stale,
            updatedAt: stale,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function apiRequest() {
        return authenticateRequest(
            new Request("https://app.example.test/api/v1/recorder/config", {
                headers: { authorization: `Bearer ${KEY}` },
            }),
        );
    }

    async function storedState() {
        const [state] = await database.db
            .select()
            .from(userAccessStates)
            .where(eq(userAccessStates.userId, USER_ID));
        return state;
    }

    async function changeAccess(
        status: "active" | "disabled" | "missing",
        capabilities: Capability[],
    ) {
        expect(
            await recordAccessState({
                userId: USER_ID,
                issuer: ISSUER,
                subject: SUBJECT,
                capabilities,
                status,
                source: "access-change",
            }),
        ).toBe(true);
        return storedState();
    }

    function pauseVerifier() {
        let release = () => {};
        const paused = new Promise<void>((resolve) => {
            release = resolve;
        });
        verify.mockImplementation(async () => {
            await paused;
            await setTimeout(10);
            return { status: "active", capabilities: new Set(["use"]) };
        });
        return release;
    }

    it("admits all concurrent holder checks after the stored verification expires", async () => {
        const release = pauseVerifier();
        const pending = Promise.all(
            Array.from({ length: REQUESTS }, () => holderAccess(USER_ID)),
        );
        try {
            await vi.waitFor(() =>
                expect(verify).toHaveBeenCalledTimes(REQUESTS),
            );
        } finally {
            release();
        }
        const results = await pending;
        expect(results).toEqual(
            Array.from({ length: REQUESTS }, () => ({
                ok: true,
                capabilities: new Set(["use"]),
                verifiedAt: expect.any(Date),
            })),
        );
    });

    it("authenticates all concurrent API-key requests after verification expires", async () => {
        const release = pauseVerifier();
        const pending = Promise.allSettled(
            Array.from({ length: REQUESTS }, apiRequest),
        );
        try {
            await vi.waitFor(() =>
                expect(verify).toHaveBeenCalledTimes(REQUESTS),
            );
        } finally {
            release();
        }
        expect(await pending).toEqual(
            Array.from({ length: REQUESTS }, () => ({
                status: "fulfilled",
                value: {
                    user: { id: USER_ID },
                    via: "api-key",
                    apiKeyId: "parallel-key",
                    scopes: ["recordings:write"],
                },
            })),
        );
    });

    it.each([
        { status: "active", capabilities: [], reason: "not-granted" },
        { status: "disabled", capabilities: ["use"], reason: "disabled" },
        { status: "missing", capabilities: ["use"], reason: "disabled" },
    ] as const)("honors a concurrent $status access change instead of the delayed grant ($reason)", async ({
        status,
        capabilities,
        reason,
    }) => {
        const release = pauseVerifier();
        const holder = holderAccess(USER_ID);
        const api = Promise.allSettled([apiRequest()]);
        let written: Awaited<ReturnType<typeof storedState>> | undefined;
        try {
            await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
            written = await changeAccess(status, [...capabilities]);
        } finally {
            release();
        }
        expect(await holder).toEqual({ ok: false, reason });
        expect(await api).toEqual([
            {
                status: "rejected",
                reason: expect.objectContaining({
                    code: "ACCESS_NOT_GRANTED",
                    statusCode: 403,
                }),
            },
        ]);
        expect(await storedState()).toEqual(written);
    });

    it.each([
        {
            verdict: { status: "active", capabilities: new Set() },
            reason: "not-granted",
        },
        { verdict: { status: "disabled" }, reason: "disabled" },
        { verdict: { status: "missing" }, reason: "disabled" },
    ] as const)("keeps its own $verdict.status denial when a concurrent grant wins the write ($reason)", async ({
        verdict,
        reason,
    }) => {
        let release = () => {};
        const paused = new Promise<void>((resolve) => {
            release = resolve;
        });
        verify.mockImplementation(async () => {
            await paused;
            return verdict.status === "active"
                ? { status: "active", capabilities: new Set<Capability>() }
                : { status: verdict.status };
        });
        const pending = holderAccess(USER_ID);
        let written: Awaited<ReturnType<typeof storedState>> | undefined;
        try {
            await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
            written = await changeAccess("active", ["use"]);
        } finally {
            release();
        }
        expect(await pending).toEqual({ ok: false, reason });
        expect(await storedState()).toEqual(written);
    });

    it("uses the winning row's capabilities and verification time", async () => {
        const release = pauseVerifier();
        const pending = holderAccess(USER_ID);
        let written: Awaited<ReturnType<typeof storedState>> | undefined;
        try {
            await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
            written = await changeAccess("active", ["use", "org.curate"]);
        } finally {
            release();
        }
        expect(await pending).toEqual({
            ok: true,
            capabilities: new Set(["use", "org.curate"]),
            verifiedAt: written?.verifiedAt,
        });
        expect(await storedState()).toEqual(written);
    });

    it("returns unavailable when the winning verification has reached the max age", async () => {
        const release = pauseVerifier();
        const holder = holderAccess(USER_ID);
        const api = Promise.allSettled([apiRequest()]);
        try {
            await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
            const written = await changeAccess("active", ["use"]);
            vi.spyOn(Date, "now").mockReturnValue(
                written.verifiedAt.getTime() + 1800_000,
            );
        } finally {
            release();
        }
        expect(await holder).toEqual({ ok: false, reason: "unavailable" });
        expect(await api).toEqual([
            {
                status: "rejected",
                reason: expect.objectContaining({
                    code: "ACCESS_UNVERIFIABLE",
                    statusCode: 503,
                }),
            },
        ]);
    });

    it("still rejects a concurrent fresh grant during a read-only check", async () => {
        const release = pauseVerifier();
        const pending = holderAccess(USER_ID, { readOnly: true });
        let written: Awaited<ReturnType<typeof storedState>> | undefined;
        try {
            await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
            written = await changeAccess("active", ["use"]);
        } finally {
            release();
        }
        expect(await pending).toEqual({ ok: false, reason: "unavailable" });
        expect(await storedState()).toEqual(written);
    });
});
