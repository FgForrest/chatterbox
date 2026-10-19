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
    apiRateLimitBuckets,
    chatterItems,
    itemProcessing,
    processingProfiles,
    recordings,
    userSettings,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { encryptText } from "@/lib/encryption/fields";
import { gatherFacts } from "@/lib/pipeline/facts";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { ensureProfiles } from "@/lib/profiles/seed";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, state, transcribe, persist } = vi.hoisted(
    () => {
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
            mockEnv: {
                IS_HOSTED: false,
                SELF_HOST_MODE: "shared",
                ORG_ACCOUNT_EMAIL: "org@example.test",
                ORG_ACCOUNT_PASSWORD: "password" as string | undefined,
                AUTHZ_MODE: "local",
                ENCRYPTION_KEY:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60,
                BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            },
            state: { mayUse: true, idp: false, mynahConfigured: false },
            transcribe: vi.fn(),
            persist: vi.fn(),
        };
    },
);

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
}));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: async () =>
        state.mayUse
            ? {
                  ok: true,
                  capabilities: new Set(["use"]),
                  verifiedAt: new Date(),
              }
            : { ok: false, reason: "not-granted" },
}));
vi.mock("@/lib/entitlements", () => ({ isHostedLockedOut: async () => false }));
vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: () => state.mynahConfigured,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => ({
        downloadFile: async () => Buffer.from("audio"),
    }),
}));
vi.mock("@/lib/transcription/elevenlabs-transcribe", () => ({
    elevenLabsTakesKeyterms: () => false,
    elevenLabsTranscribe: transcribe,
}));
vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: persist,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: async () => {},
    removeRecordingSidecar: async () => {},
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: async () => {} }));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: async () => {} }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: async () => {},
    captureServerException: () => {},
}));

const url = getTestDatabaseUrl();
const withDatabase = url ? describe : describe.skip;
const ORG = "org-fallback-org";
const MEMBER = "org-fallback-member";
const ITEM = "org-fallback-recording";

withDatabase(
    "new members use Organization credentials without Organization defaults",
    () => {
        let database: TestPostgresDatabase;

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "org_fallback_new_member",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await database.db.insert(users).values([
                { id: ORG, email: "org@example.test", role: "org" },
                { id: MEMBER, email: "new-member@example.test" },
            ]);
            await database.db
                .insert(userSettings)
                .values({ userId: ORG, autoTranscribe: true });
            await ensureProfiles(ORG);
            await database.db.insert(apiCredentials).values([
                {
                    id: "org-elevenlabs",
                    userId: ORG,
                    provider: "ElevenLabs",
                    apiKey: encrypt("elevenlabs-key"),
                    defaultModel: "scribe_v2+diarize",
                    createdAt: new Date("2026-01-02"),
                },
                {
                    id: "org-codex-luna",
                    userId: ORG,
                    provider: "Codex",
                    apiKey: encrypt("luna-key"),
                    defaultModel: "gpt-6-luna",
                    createdAt: new Date("2026-01-01"),
                },
                {
                    id: "org-codex-sol",
                    userId: ORG,
                    provider: "Codex",
                    apiKey: encrypt("sol-key"),
                    defaultModel: "gpt-6-sol",
                    createdAt: new Date("2026-01-03"),
                },
            ]);
            await database.db.insert(chatterItems).values({
                id: ITEM,
                userId: MEMBER,
                kind: "audio",
                title: encryptText("Meeting"),
                occurredAt: new Date(),
            });
            await database.db.insert(recordings).values({
                id: ITEM,
                userId: MEMBER,
                plaudFileId: "new-member-file",
                deviceSn: "upload",
                plaudVersion: "1",
                endTime: new Date(),
                filesize: 5,
                storageType: "local",
                storageFilename: "meeting.mp3",
                storagePath: "meeting.mp3",
                duration: 60_000,
                fileMd5: "a".repeat(32),
            });
        }, 120_000);

        beforeEach(async () => {
            mockEnv.ORG_ACCOUNT_PASSWORD = "password";
            mockEnv.IS_HOSTED = false;
            state.idp = false;
            state.mynahConfigured = false;
            state.mayUse = true;
            transcribe.mockReset().mockResolvedValue({
                text: "A meeting",
                detectedLanguage: "en",
                turns: [],
            });
            persist.mockReset().mockResolvedValue({ committed: true });
            await database.db
                .delete(itemProcessing)
                .where(eq(itemProcessing.userId, MEMBER));
            await database.db
                .delete(userSettings)
                .where(eq(userSettings.userId, MEMBER));
            await database.db
                .delete(apiCredentials)
                .where(eq(apiCredentials.userId, MEMBER));
            await database.db
                .delete(aiUsageEvents)
                .where(eq(aiUsageEvents.userId, MEMBER));
            await database.db.delete(apiRateLimitBuckets);
        });

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        it("reproduces enabled credentials and two default profiles with no pointers or pins", async () => {
            const [settings] = await database.db
                .select()
                .from(userSettings)
                .where(eq(userSettings.userId, ORG));
            expect(settings.defaultTranscriptionProviderId).toBeNull();
            expect(settings.defaultProviders).toBeNull();
            const credentials = await database.db
                .select()
                .from(apiCredentials)
                .where(eq(apiCredentials.userId, ORG));
            expect(credentials).toHaveLength(3);
            expect(
                credentials.every(
                    (row) =>
                        !row.isDefaultTranscription &&
                        !row.isDefaultEnhancement &&
                        !row.disabledAt,
                ),
            ).toBe(true);
            const profiles = await database.db
                .select()
                .from(processingProfiles)
                .where(
                    and(
                        eq(processingProfiles.ownerUserId, ORG),
                        eq(processingProfiles.isDefault, true),
                    ),
                );
            expect(profiles).toHaveLength(2);
            const profile = await resolveItemProfile(ITEM, "private", MEMBER);
            for (const step of Object.values(profile.settings.steps)) {
                if ("provider" in step) expect(step.provider).toBeNull();
            }
            expect(
                await database.db
                    .select()
                    .from(processingProfiles)
                    .where(eq(processingProfiles.ownerUserId, MEMBER)),
            ).toEqual([]);
        });

        it.each([
            "manual",
            "pipeline",
        ] as const)("transcribes via the Organization fallback for a %s run and records its payer and rate bucket", async (trigger) => {
            if (trigger === "pipeline") {
                const profile = await resolveItemProfile(
                    ITEM,
                    "private",
                    MEMBER,
                );
                await database.db.insert(itemProcessing).values({
                    itemId: ITEM,
                    userId: MEMBER,
                    view: "private",
                    profileId: profile.profile.id,
                    profileRevisionId: profile.revisionId,
                });
                expect(
                    "transcribe" in profile.settings.steps &&
                        profile.settings.steps.transcribe.automatic,
                ).toBe(true);
            }
            expect(
                await transcribeRecording(MEMBER, ITEM, { trigger }),
            ).toMatchObject({ success: true });
            expect(transcribe).toHaveBeenCalledWith(
                expect.objectContaining({
                    apiKey: "elevenlabs-key",
                    model: "scribe_v2+diarize",
                }),
            );
            expect(persist).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: MEMBER,
                    actorUserId: MEMBER,
                    payerUserId: ORG,
                }),
            );
            const [usage] = await database.db
                .select()
                .from(aiUsageEvents)
                .where(eq(aiUsageEvents.userId, MEMBER));
            expect(usage).toMatchObject({
                actorUserId: MEMBER,
                payerUserId: ORG,
                provider: "ElevenLabs",
                operation: "transcription",
            });
            expect(
                await database.db.select().from(apiRateLimitBuckets),
            ).toHaveLength(1);
        });

        it.each([
            "summary",
            "learn",
            "topics",
            "title",
        ] as const)("resolves %s to the oldest chat credential with the Organization as payer", async (step) => {
            expect(
                await resolveStepProviderSelection({
                    step,
                    pin: null,
                    actorUserId: MEMBER,
                }),
            ).toMatchObject({
                credential: { id: "org-codex-luna" },
                payerUserId: ORG,
                organizationCredential: true,
            });
        });

        it("makes pipeline availability agree without reserving a provider call", async () => {
            expect(
                await gatherFacts("missing-item", "private", MEMBER),
            ).toMatchObject({ hasEnhancementCredential: true });
            expect(
                await database.db.select().from(apiRateLimitBuckets),
            ).toEqual([]);
        });

        it("fails an explicit missing profile pin and an explicit providerId without using a fallback", async () => {
            await expect(
                resolveStepProviderSelection({
                    step: "transcription",
                    pin: { scope: "organization", credentialId: "missing" },
                    actorUserId: MEMBER,
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(
                await transcribeRecording(MEMBER, ITEM, {
                    providerId: "missing",
                }),
            ).toMatchObject({
                success: false,
                errorCode: "NO_TRANSCRIPTION_PROVIDER",
            });
            expect(transcribe).not.toHaveBeenCalled();
        });

        it("keeps transcription unavailable when the Organization scope is disabled", async () => {
            mockEnv.ORG_ACCOUNT_PASSWORD = undefined;
            await expect(
                resolveStepProviderSelection({
                    step: "transcription",
                    pin: null,
                    actorUserId: MEMBER,
                }),
            ).rejects.toMatchObject({ code: "NO_TRANSCRIPTION_PROVIDER" });
        });

        it("does not use Organization fallback without permission", async () => {
            state.idp = true;
            state.mayUse = false;
            await expect(
                resolveStepProviderSelection({
                    step: "transcription",
                    pin: null,
                    actorUserId: MEMBER,
                }),
            ).rejects.toMatchObject({ code: "NO_TRANSCRIPTION_PROVIDER" });
        });

        it("preserves the organization account's own transcription resolution", async () => {
            await expect(
                resolveStepProviderSelection({
                    step: "transcription",
                    pin: null,
                    actorUserId: ORG,
                }),
            ).rejects.toMatchObject({ code: "NO_TRANSCRIPTION_PROVIDER" });
        });

        it("keeps hosted Mynah fallback ahead of inaccessible Organization credentials", async () => {
            mockEnv.IS_HOSTED = true;
            state.mynahConfigured = true;
            expect(
                await resolveStepProviderSelection({
                    step: "transcription",
                    pin: null,
                    actorUserId: MEMBER,
                }),
            ).toMatchObject({
                kind: "managed",
                payerUserId: MEMBER,
                organizationCredential: false,
            });
        });

        it("prefers the member's own implicit chat credential", async () => {
            await database.db.insert(apiCredentials).values({
                id: "member-chat",
                userId: MEMBER,
                provider: "OpenAI",
                apiKey: encrypt("own-key"),
                defaultModel: "gpt-4o-mini",
            });
            expect(
                await resolveStepProviderSelection({
                    step: "summary",
                    pin: null,
                    actorUserId: MEMBER,
                }),
            ).toMatchObject({
                credential: { id: "member-chat" },
                payerUserId: MEMBER,
                organizationCredential: false,
            });
        });

        it("explains when neither the member nor the Organization has a suitable provider", async () => {
            await database.db
                .update(apiCredentials)
                .set({ disabledAt: new Date() })
                .where(
                    and(
                        eq(apiCredentials.userId, ORG),
                        eq(apiCredentials.id, "org-elevenlabs"),
                    ),
                );
            try {
                expect(await transcribeRecording(MEMBER, ITEM)).toMatchObject({
                    errorCode: "NO_TRANSCRIPTION_PROVIDER",
                    organizationProviderMissing: true,
                    error: expect.stringContaining(
                        "Neither you nor the Organization",
                    ),
                });
            } finally {
                await database.db
                    .update(apiCredentials)
                    .set({ disabledAt: null })
                    .where(
                        and(
                            eq(apiCredentials.userId, ORG),
                            eq(apiCredentials.id, "org-elevenlabs"),
                        ),
                    );
            }
        });
    },
);
