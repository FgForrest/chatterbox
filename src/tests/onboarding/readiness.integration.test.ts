import { eq } from "drizzle-orm";
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
    apiCredentials,
    oauthConnections,
    plaudConnections,
    processingProfileRevisions,
    processingProfiles,
    userAccessStates,
    userSettings,
    users,
} from "@/db/schema";
import { setDefaultProvider } from "@/lib/ai/default-provider";
import { GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE } from "@/lib/integrations/google/config";
import {
    loadOnboardingCapabilities,
    loadOnboardingReadiness,
} from "@/lib/onboarding/readiness";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbRef, dbProxy, state, decrypt, reserve, seed, verify } = vi.hoisted(
    () => {
        const ref: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        return {
            dbRef: ref,
            dbProxy: new Proxy(
                {},
                {
                    get: (_target, property) => {
                        if (!ref.current)
                            throw new Error("test database not ready");
                        const value = ref.current[property];
                        return typeof value === "function"
                            ? value.bind(ref.current)
                            : value;
                    },
                },
            ),
            state: { mynah: false, seconds: 3600, idp: false },
            verify: vi.fn(async () => ({
                status: "active" as const,
                capabilities: new Set(["use"]),
            })),
            decrypt: vi.fn(() => {
                throw new Error("keys must not be decrypted");
            }),
            reserve: vi.fn(),
            seed: vi.fn(() => {
                throw new Error("profiles must not be seeded");
            }),
        };
    },
);
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "org-password-test",
        ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60,
        AUTHZ_VERIFICATION_MAX_AGE: 60,
    },
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => state.idp,
    getAccessVerifier: () => ({ verify }),
}));
vi.mock("@/lib/sso/config", () => ({ isSsoEnabled: () => false }));
vi.mock("@/lib/integrations/google/config", () => ({
    getGoogleOAuthConfig: () => ({}),
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE: "calendar",
}));
vi.mock("@/lib/mail/config", () => ({ isMailEnabled: () => false }));
vi.mock("@/lib/mcp/config", () => ({ isMcpEnabled: () => false }));
vi.mock("@/lib/profiles/seed", () => ({ ensureProfiles: seed }));
vi.mock("@/lib/encryption", () => ({ decrypt, encrypt: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimitBucket: reserve }));
vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: () => state.mynah,
}));
vi.mock("@/lib/entitlements", () => ({
    getEntitlements: async () => ({ monthlyMynahSeconds: state.seconds }),
}));

const url = getTestDatabaseUrl();
describe.skipIf(!url)("onboarding read-only readiness (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    const client = () => database.db;
    async function credential(id: string, provider: string, userId = "org") {
        await client()
            .insert(apiCredentials)
            .values({ id, provider, userId, apiKey: `secret-${id}` });
    }
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "onboarding_readiness",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await client()
            .insert(users)
            .values([
                { id: "org", email: "org@example.test", role: "org" },
                { id: "member", email: "member@example.test" },
                { id: "other", email: "other@example.test" },
            ]);
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await client().delete(userAccessStates);
        await client().delete(accounts);
        await client().delete(processingProfiles);
        await client().delete(userSettings);
        await client().delete(apiCredentials);
        await client().delete(plaudConnections);
        await client().delete(oauthConnections);
        state.mynah = false;
        state.idp = false;
        state.seconds = 3600;
        vi.clearAllMocks();
    });
    async function read(userId = "member") {
        return loadOnboardingReadiness(
            userId,
            await loadOnboardingCapabilities(userId),
        );
    }
    async function staleAccess() {
        state.idp = true;
        await credential("speech", "ElevenLabs");
        await credential("chat", "Codex");
        await setDefaultProvider("org", "transcription", "speech");
        await setDefaultProvider("org", "summary", "chat");
        await client().insert(accounts).values({
            userId: "member",
            providerId: SSO_PROVIDER_ID,
            accountId: "member-subject",
            issuer: "https://identity.example.test",
        });
        const stale = new Date(Date.now() - 3600_000);
        await client()
            .insert(userAccessStates)
            .values({
                userId: "member",
                issuer: "https://identity.example.test",
                subject: "member-subject",
                capabilities: ["use"],
                status: "active",
                verifiedAt: stale,
                updatedAt: stale,
                source: "login",
            });
        return stale;
    }
    it("does not persist a refreshed IdP verdict while checking readiness", async () => {
        await staleAccess();
        const before = await client()
            .select()
            .from(userAccessStates)
            .where(eq(userAccessStates.userId, "member"));
        const result = await read();
        expect(result.ai.transcription.source).toBe("organization");
        expect(result.ai.summary.status).toBe("ready");
        expect(verify).toHaveBeenCalled();
        expect(
            await client()
                .select()
                .from(userAccessStates)
                .where(eq(userAccessStates.userId, "member")),
        ).toEqual(before);
        expect(seed).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(decrypt).not.toHaveBeenCalled();
    });
    it("still caches authorization during normal pipeline resolution", async () => {
        const stale = await staleAccess();
        const result = await resolveStepProviderSelection({
            step: "transcription",
            pin: null,
            actorUserId: "member",
        });
        expect(result.organizationCredential).toBe(true);
        const [after] = await client()
            .select()
            .from(userAccessStates)
            .where(eq(userAccessStates.userId, "member"));
        expect(after.verifiedAt.getTime()).toBeGreaterThan(stale.getTime());
        expect(after.source).toBe("verifier");
    });
    it("reports Organization defaults, including the summary-only Codex bridge", async () => {
        await credential("speech", "ElevenLabs");
        await credential("chat", "Codex");
        await setDefaultProvider("org", "transcription", "speech");
        await setDefaultProvider("org", "summary", "chat");
        const result = await read();
        expect(result.ai.transcription).toEqual({
            source: "organization",
            name: "ElevenLabs",
            status: "ready",
        });
        expect(result.ai.summary).toEqual({
            source: "organization",
            name: "Codex",
            status: "ready",
        });
        expect(JSON.stringify(result)).not.toMatch(
            /secret|apiKey|baseUrl|reserveCall/,
        );
        expect(decrypt).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(seed).not.toHaveBeenCalled();
        expect(await client().select().from(processingProfiles)).toEqual([]);
        expect(
            await client()
                .select()
                .from(userSettings)
                .where(eq(userSettings.userId, "member")),
        ).toEqual([]);
    });
    it("tracks the pipeline for Organization providers without defaults, including after the fallback merges", async () => {
        await credential("speech", "ElevenLabs");
        await credential("chat", "Claude Code");
        const result = await read();
        for (const role of ["transcription", "summary"] as const) {
            const pipeline = await resolveStepProviderSelection({
                step: role,
                pin: null,
                actorUserId: "member",
            }).catch(() => null);
            expect(result.ai[role]).toEqual(
                pipeline?.kind === "credential"
                    ? {
                          source: "organization",
                          name:
                              role === "transcription"
                                  ? "ElevenLabs"
                                  : "Claude Code",
                          status: "ready",
                      }
                    : { source: "none", name: null, status: "not-connected" },
            );
        }
    });
    it("respects a personal explicit provider without leaking another user's credentials", async () => {
        await credential("own", "OpenAI", "member");
        await credential("foreign", "Groq", "other");
        await setDefaultProvider("member", "transcription", "own");
        await setDefaultProvider("member", "summary", "own");
        const result = await read();
        expect(result.ai.transcription).toEqual({
            source: "own",
            name: "OpenAI",
            status: "ready",
        });
        expect(result.ai.summary.source).toBe("own");
        const stranger = await read("other");
        expect(stranger.ai.transcription.source).toBe("none");
        await setDefaultProvider("member", "transcription", "foreign");
        expect((await read()).ai.transcription.source).toBe("none");
    });
    it("counts profile pins before default providers and fails unavailable explicit profiles", async () => {
        await credential("own", "OpenAI", "member");
        await credential("speech", "ElevenLabs");
        await credential("chat", "Codex");
        await setDefaultProvider("member", "transcription", "own");
        const settings = defaultProfileSettings("audio");
        settings.steps.transcribe.provider = {
            scope: "organization",
            credentialId: "speech",
        };
        settings.steps.summary.provider = {
            scope: "organization",
            credentialId: "chat",
        };
        await client().insert(processingProfiles).values({
            id: "profile",
            ownerUserId: "org",
            scope: "organization",
            channel: "audio",
            name: "Meetings",
            currentRevisionId: "revision",
            isDefault: true,
            createdBy: "org",
            updatedBy: "org",
        });
        await client()
            .insert(processingProfileRevisions)
            .values({
                id: "revision",
                profileId: "profile",
                settings: JSON.stringify(settings),
                createdBy: "org",
            });
        const result = await read();
        expect(result.ai.transcription.source).toBe("organization");
        expect(result.ai.summary.name).toBe("Codex");
        expect(result.profiles.audio).toEqual({
            status: "ready",
            name: "Meetings",
        });
        await client()
            .update(processingProfiles)
            .set({ archivedAt: new Date() })
            .where(eq(processingProfiles.ownerUserId, "org"));
        await client()
            .insert(userSettings)
            .values({ userId: "member", defaultAudioProfileId: "profile" })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { defaultAudioProfileId: "profile" },
            });
        expect((await read()).ai.summary.status).toBe("error");
    });
    it("rejects a summary-only bridge for transcription and a disabled selection", async () => {
        await credential("chat", "Claude Code");
        await setDefaultProvider("org", "transcription", "chat");
        await setDefaultProvider("org", "summary", "chat");
        expect((await read()).ai.transcription.status).toBe("not-connected");
        expect((await read()).ai.summary.status).toBe("ready");
        await client()
            .update(apiCredentials)
            .set({ disabledAt: new Date() })
            .where(eq(apiCredentials.userId, "org"));
        expect((await read()).ai.summary.status).toBe("not-connected");
    });
    it("uses role identity for the Organization account and omits personal checks", async () => {
        await credential("org-openai", "OpenAI");
        await setDefaultProvider("org", "transcription", "org-openai");
        await setDefaultProvider("org", "summary", "org-openai");
        const caps = await loadOnboardingCapabilities("org");
        expect(caps.audience).toBe("organization-account");
        expect(caps.mailAvailable).toBe(false);
        const result = await loadOnboardingReadiness("org", caps);
        expect(result.ai.transcription).toEqual({
            source: "organization",
            name: "OpenAI",
            status: "ready",
        });
        expect(result.ai.summary.source).toBe("organization");
        expect(result.plaud).toBe("not-connected");
        expect(result.google).toBe("not-connected");
        expect(result.profiles.mail).not.toBeNull();
    });
    it("hydrates reconnect flags independently of step visits", async () => {
        await client().insert(plaudConnections).values({
            userId: "member",
            bearerToken: "secret-plaud",
            invalidatedAt: new Date(),
        });
        await client().insert(oauthConnections).values({
            userId: "member",
            provider: "google",
            subject: "google-member",
            email: "member@example.test",
            refreshToken: "secret-google",
            status: "needs_reconnect",
            scopes: GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
        });
        const result = await read();
        expect(result.plaud).toBe("needs-reconnect");
        expect(result.google).toBe("needs-reconnect");
        expect(decrypt).not.toHaveBeenCalled();
    });
    it.each([
        0, 3600,
    ])("checks managed entitlement %s without reserving usage", async (seconds) => {
        state.mynah = true;
        state.seconds = seconds;
        expect((await read()).ai.transcription).toEqual({
            source: "managed",
            name: "Mynah",
            status: seconds ? "ready" : "not-connected",
        });
        expect(reserve).not.toHaveBeenCalled();
    });
});
