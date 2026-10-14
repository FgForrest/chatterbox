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
import { apiCredentials, userSettings, users } from "@/db/schema";
import {
    pickEnhancementCredential,
    pickLearnCredential,
    pickTopicsCredential,
} from "@/lib/ai/enhancement-provider";
import { titleProviderId } from "@/lib/ai/title-provider";
import { RIFFADO_INCLUDED_PROVIDER_ID } from "@/lib/transcription/included-provider";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, state, consumeRateLimitBucket } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property: string | symbol) => {
                    if (!ref.current)
                        throw new Error("test database not ready");
                    const value = ref.current[property];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
        state: {
            orgEnabled: true,
            idp: false,
            holderMayUse: true,
            mynahConfigured: false,
            mynahSeconds: 3600,
        },
        consumeRateLimitBucket: vi.fn(),
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60,
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
        API_TOKEN_HASH_SECRET: undefined,
    },
}));
vi.mock("@/lib/encryption", () => ({ decrypt: (value: string) => value }));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org-user",
    isOrgScopeEnabled: () => state.orgEnabled,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
}));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: async () =>
        state.holderMayUse
            ? {
                  ok: true,
                  capabilities: new Set(["use"]),
                  verifiedAt: new Date(),
              }
            : { ok: false, reason: "not-granted" },
}));
vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: () => state.mynahConfigured,
}));
vi.mock("@/lib/entitlements", () => ({
    getEntitlements: async () => ({ monthlyMynahSeconds: state.mynahSeconds }),
}));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimitBucket }));

import { resolveStepProvider } from "@/lib/profiles/providers";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("profile step provider resolution (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function databaseClient() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function insertCredential(input: {
        id: string;
        userId?: string;
        provider?: string;
        isDefaultEnhancement?: boolean;
        isDefaultLearn?: boolean;
        isDefaultTranscription?: boolean;
        disabledAt?: Date | null;
    }) {
        await databaseClient()
            .insert(apiCredentials)
            .values({
                id: input.id,
                userId: input.userId ?? "actor",
                provider: input.provider ?? "OpenAI",
                apiKey: `key-${input.id}`,
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: input.isDefaultEnhancement ?? false,
                isDefaultLearn: input.isDefaultLearn ?? false,
                isDefaultTranscription: input.isDefaultTranscription ?? false,
                disabledAt: input.disabledAt ?? null,
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "profile_providers",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await databaseClient()
            .insert(users)
            .values([
                { id: "actor", email: "actor@example.test" },
                { id: "foreign", email: "foreign@example.test" },
                { id: "org-user", email: "org@example.test", role: "org" },
            ]);
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        state.orgEnabled = true;
        state.idp = false;
        state.holderMayUse = true;
        state.mynahConfigured = false;
        state.mynahSeconds = 3600;
        consumeRateLimitBucket.mockReset().mockResolvedValue({
            allowed: true,
            limit: 60,
            remaining: 59,
            resetAt: new Date(Date.now() + 3600_000),
        });
        await databaseClient().delete(userSettings);
        await databaseClient().delete(apiCredentials);
        await Promise.all([
            insertCredential({
                id: "transcription",
                isDefaultTranscription: true,
            }),
            insertCredential({
                id: "summary",
                isDefaultEnhancement: true,
            }),
            insertCredential({ id: "learn", isDefaultLearn: true }),
            insertCredential({ id: "topics" }),
            insertCredential({ id: "title" }),
            insertCredential({ id: "foreign-card", userId: "foreign" }),
            insertCredential({ id: "org-card", userId: "org-user" }),
            insertCredential({
                id: "org-disabled",
                userId: "org-user",
                disabledAt: new Date(),
            }),
        ]);
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "actor",
                defaultTranscriptionProviderId: "transcription",
                defaultProviders: { topics: "topics", title: "title" },
            });
    });

    for (const step of [
        "transcription",
        "summary",
        "learn",
        "topics",
        "title",
    ] as const) {
        it(`keeps today's unpinned ${step} selection`, async () => {
            const rows = await databaseClient()
                .select()
                .from(apiCredentials)
                .where(eq(apiCredentials.userId, "actor"))
                .orderBy(apiCredentials.createdAt, apiCredentials.id);
            const [settings] = await databaseClient()
                .select()
                .from(userSettings)
                .where(eq(userSettings.userId, "actor"));
            const expected =
                step === "transcription"
                    ? settings?.defaultTranscriptionProviderId
                    : step === "summary"
                      ? pickEnhancementCredential(rows)?.id
                      : step === "learn"
                        ? pickLearnCredential(rows)?.id
                        : step === "topics"
                          ? pickTopicsCredential(
                                rows,
                                (
                                    settings?.defaultProviders as {
                                        topics?: string;
                                    }
                                )?.topics ?? null,
                            )?.id
                          : (
                                rows.find(
                                    (row) =>
                                        row.id ===
                                        titleProviderId(
                                            settings?.defaultProviders,
                                        ),
                                ) ?? pickEnhancementCredential(rows)
                            )?.id;

            const resolved = await resolveStepProvider({
                step,
                pin: null,
                actorUserId: "actor",
            });

            expect(resolved.kind).toBe("credential");
            expect(resolved.credential?.id).toBe(expected);
            expect(resolved.payerUserId).toBe("actor");
        });
    }

    it("accepts an owned personal pin and rejects a foreign one", async () => {
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: { credentialId: "summary", scope: "personal" },
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({
            kind: "credential",
            payerUserId: "actor",
            credential: { id: "summary", apiKey: "key-summary" },
        });
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: { credentialId: "foreign-card", scope: "personal" },
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("resolves an enabled Organization pin and charges the organization", async () => {
        const resolved = await resolveStepProvider({
            step: "summary",
            pin: { credentialId: "org-card", scope: "organization" },
            actorUserId: "actor",
        });
        expect(resolved).toMatchObject({
            kind: "credential",
            payerUserId: "org-user",
            credential: { id: "org-card" },
        });
        await resolved.reserveCall();
        expect(consumeRateLimitBucket).toHaveBeenCalledWith(
            "org-provider:org-card:actor",
            { limit: 60, windowMs: 3_600_000 },
        );
    });

    it("rejects disabled and non-Organization credentials for an Organization pin", async () => {
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: {
                    credentialId: "org-disabled",
                    scope: "organization",
                },
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: { credentialId: "summary", scope: "organization" },
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects Organization use when scope or current holder access is missing", async () => {
        state.orgEnabled = false;
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: { credentialId: "org-card", scope: "organization" },
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });

        state.orgEnabled = true;
        state.idp = true;
        state.holderMayUse = false;
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: { credentialId: "org-card", scope: "organization" },
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("throws an actionable error when the Organization cap is exhausted", async () => {
        consumeRateLimitBucket.mockResolvedValue({
            allowed: false,
            limit: 60,
            remaining: 0,
            resetAt: new Date(Date.now() + 3600_000),
        });
        const resolved = await resolveStepProvider({
            step: "summary",
            pin: { credentialId: "org-card", scope: "organization" },
            actorUserId: "actor",
        });
        await expect(resolved.reserveCall()).rejects.toMatchObject({
            code: "AI_RATE_LIMITED",
            statusCode: 429,
        });
    });

    it("resolves a Mynah transcription pin without checking runtime availability", async () => {
        state.mynahConfigured = true;
        await expect(
            resolveStepProvider({
                step: "transcription",
                pin: {
                    credentialId: RIFFADO_INCLUDED_PROVIDER_ID,
                    scope: "personal",
                },
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({ kind: "managed", payerUserId: "actor" });

        state.mynahConfigured = false;
        await expect(
            resolveStepProvider({
                step: "transcription",
                pin: {
                    credentialId: RIFFADO_INCLUDED_PROVIDER_ID,
                    scope: "personal",
                },
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({ kind: "managed", payerUserId: "actor" });
    });

    it("excludes disabled credentials from default picks", async () => {
        await databaseClient()
            .update(apiCredentials)
            .set({ disabledAt: new Date() })
            .where(
                and(
                    eq(apiCredentials.id, "summary"),
                    eq(apiCredentials.userId, "actor"),
                ),
            );
        const resolved = await resolveStepProvider({
            step: "summary",
            pin: null,
            actorUserId: "actor",
        });
        expect(resolved.credential?.id).not.toBe("summary");
        expect(resolved.credential?.disabledAt).toBeNull();
    });
});
