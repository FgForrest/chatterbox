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
    aiUsageEvents,
    apiCredentials,
    chatterItems,
    userSettings,
    users,
} from "@/db/schema";
import { recordAiUsage } from "@/lib/ai/usage-cost";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
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
            const expected = {
                transcription: "transcription",
                summary: "summary",
                learn: "learn",
                topics: "topics",
                title: "title",
            }[step];

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

    it("uses Organization transcription and summary defaults for a member with no provider", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultTranscriptionProviderId: "org-card",
                defaultProviders: { summary: "org-card" },
            });

        for (const step of ["transcription", "summary"] as const) {
            const resolved = await resolveStepProvider({
                step,
                pin: null,
                actorUserId: "actor",
            });
            expect(resolved).toMatchObject({
                kind: "credential",
                payerUserId: "org-user",
                organizationCredential: true,
                credential: { id: "org-card" },
            });
        }
    });

    it("records resolved transcription and summary usage against the Organization payer", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultTranscriptionProviderId: "org-card",
                defaultProviders: { summary: "org-card" },
            });
        await databaseClient().insert(chatterItems).values({
            id: "org-default-usage-item",
            userId: "actor",
            kind: "audio",
            title: "encrypted",
            occurredAt: new Date(),
        });

        for (const operation of ["transcription", "summary"] as const) {
            const resolved = await resolveStepProvider({
                step: operation,
                pin: null,
                actorUserId: "actor",
            });
            if (resolved.kind !== "credential") {
                throw new Error("expected a credential provider");
            }
            await recordAiUsage(
                {
                    recordingId: "org-default-usage-item",
                    ownerUserId: "actor",
                    actorUserId: "actor",
                    payerUserId: resolved.payerUserId,
                    operation,
                    provider: resolved.credential.provider,
                    model: resolved.credential.defaultModel ?? "gpt-4o-mini",
                    credentialId: resolved.credential.id,
                },
                operation === "transcription"
                    ? { audioSeconds: 30 }
                    : { inputTokens: 100, outputTokens: 20 },
            );
        }

        const usage = await databaseClient()
            .select()
            .from(aiUsageEvents)
            .where(eq(aiUsageEvents.itemId, "org-default-usage-item"));
        expect(usage).toHaveLength(2);
        expect(usage).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    operation: "transcription",
                    actorUserId: "actor",
                    payerUserId: "org-user",
                }),
                expect.objectContaining({
                    operation: "summary",
                    actorUserId: "actor",
                    payerUserId: "org-user",
                }),
            ]),
        );
    });

    it("offers Learn through an Organization default and an Organization pin", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultProviders: { learn: "org-card" },
            });

        await expect(isLearnAvailableFor("actor")).resolves.toBe(true);
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "org-user"));
        await expect(
            isLearnAvailableFor("actor", {
                scope: "organization",
                credentialId: "org-card",
            }),
        ).resolves.toBe(true);
    });

    it("prefers a member pointer over the Organization default", async () => {
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultProviders: { summary: "org-card" },
            });
        await databaseClient()
            .update(userSettings)
            .set({ defaultProviders: { summary: "summary" } })
            .where(eq(userSettings.userId, "actor"));
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({
            payerUserId: "actor",
            credential: { id: "summary" },
        });
    });

    it("allows a member pointer to select a non-default Organization provider", async () => {
        await insertCredential({ id: "org-other", userId: "org-user" });
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultProviders: { summary: "org-card" },
            });
        await databaseClient()
            .update(userSettings)
            .set({ defaultProviders: { summary: "org-other" } })
            .where(eq(userSettings.userId, "actor"));
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({
            payerUserId: "org-user",
            organizationCredential: true,
            credential: { id: "org-other" },
        });
    });

    it("skips Organization defaults for an unauthorized member", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultProviders: { summary: "org-card" },
            });
        state.idp = true;
        state.holderMayUse = false;
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({ code: "AI_PROVIDER_NOT_CONFIGURED" });
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

    it("resolves a Mynah transcription pin only while Mynah is configured", async () => {
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
        ).rejects.toMatchObject({
            code: "NOT_FOUND",
            message: expect.stringContaining("no longer available"),
        });
    });

    it("fails loudly when the selected Mynah default is no longer configured", async () => {
        await databaseClient()
            .update(userSettings)
            .set({
                defaultTranscriptionProviderId: RIFFADO_INCLUDED_PROVIDER_ID,
            })
            .where(eq(userSettings.userId, "actor"));

        await expect(
            resolveStepProvider({
                step: "transcription",
                pin: null,
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({
            code: "NO_TRANSCRIPTION_PROVIDER",
            message: expect.stringContaining("no longer available"),
        });

        state.mynahConfigured = true;
        await expect(
            resolveStepProvider({
                step: "transcription",
                pin: null,
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({ kind: "managed", payerUserId: "actor" });
    });

    it("keeps summaries working for an existing user with one unflagged chat credential", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await insertCredential({ id: "unflagged-chat" });

        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({
            payerUserId: "actor",
            credential: { id: "unflagged-chat" },
        });
    });

    it("ignores a legacy summary flag on a transcription-only personal provider", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await insertCredential({
            id: "legacy-elevenlabs",
            provider: "ElevenLabs",
            isDefaultEnhancement: true,
        });
        await insertCredential({ id: "usable-summary", provider: "OpenAI" });

        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({
            payerUserId: "actor",
            credential: { id: "usable-summary" },
        });
    });

    it("preserves a disabled legacy Organization summary default", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await databaseClient()
            .update(apiCredentials)
            .set({ isDefaultEnhancement: true })
            .where(eq(apiCredentials.id, "org-disabled"));

        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            message: expect.stringContaining(
                "The Organization default for summary",
            ),
        });
    });

    it("uses the Organization default before an unflagged own chat credential", async () => {
        await databaseClient()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await insertCredential({ id: "unflagged-chat" });
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultProviders: { summary: "org-card" },
            });

        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).resolves.toMatchObject({
            payerUserId: "org-user",
            credential: { id: "org-card" },
        });
    });

    it("fails with the provider name when transcription points at a disabled credential", async () => {
        await databaseClient()
            .update(apiCredentials)
            .set({
                provider: "Named Transcriber",
                disabledAt: new Date(),
            })
            .where(
                and(
                    eq(apiCredentials.id, "transcription"),
                    eq(apiCredentials.userId, "actor"),
                ),
            );
        await expect(
            resolveStepProvider({
                step: "transcription",
                pin: null,
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            message: expect.stringContaining(
                "Your default for transcription, Named Transcriber, is disabled",
            ),
        });
    });

    it("fails with the provider name when summaries use a disabled credential", async () => {
        await databaseClient()
            .update(apiCredentials)
            .set({
                provider: "Named Summarizer",
                disabledAt: new Date(),
            })
            .where(
                and(
                    eq(apiCredentials.id, "summary"),
                    eq(apiCredentials.userId, "actor"),
                ),
            );
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            message: expect.stringContaining(
                "Your default for summary, Named Summarizer, is disabled",
            ),
        });
    });

    it("fails with the provider name when a profile pins a disabled personal credential", async () => {
        await databaseClient()
            .update(apiCredentials)
            .set({ provider: "Pinned Provider", disabledAt: new Date() })
            .where(
                and(
                    eq(apiCredentials.id, "summary"),
                    eq(apiCredentials.userId, "actor"),
                ),
            );
        await expect(
            resolveStepProvider({
                step: "summary",
                pin: { credentialId: "summary", scope: "personal" },
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            message: expect.stringContaining(
                "The profile pin for Pinned Provider is disabled",
            ),
        });
    });

    it("names a disabled Organization default and directs the member to an administrator", async () => {
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "actor"));
        await databaseClient()
            .update(apiCredentials)
            .set({ isDefaultEnhancement: false })
            .where(eq(apiCredentials.userId, "actor"));
        await databaseClient()
            .insert(userSettings)
            .values({
                userId: "org-user",
                defaultProviders: { summary: "org-disabled" },
            });

        await expect(
            resolveStepProvider({
                step: "summary",
                pin: null,
                actorUserId: "actor",
            }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            message: expect.stringContaining(
                "The Organization default for summary, OpenAI, is disabled. Ask an administrator",
            ),
        });
    });
});
