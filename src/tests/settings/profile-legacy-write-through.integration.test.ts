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
import { processingProfiles, userSettings, users } from "@/db/schema";
import type { Capability } from "@/lib/authz/catalog";
import type { ActorContext } from "@/lib/authz/model";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef } = vi.hoisted(() => {
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
    };
});

const { authState, orgState } = vi.hoisted(() => ({
    authState: {
        actor: {
            kind: "user" as const,
            actorId: "legacy-profile-user",
            issuer: "https://idp.example.test",
            subject: "legacy-profile-user",
            capabilities: new Set<Capability>(["use"]),
            clientId: null,
            clientPermissions: new Set(),
            verifiedAt: new Date(),
        } satisfies ActorContext,
    },
    orgState: {
        orgUserId: null as string | null,
    },
}));

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "idp",
        ORG_ACCOUNT_EMAIL: undefined,
        ORG_ACCOUNT_PASSWORD: undefined,
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: "legacy-profile-user", email: "legacy@example.test" },
    }),
    requireApiSessionActor: async () => ({
        session: {
            user: { id: "legacy-profile-user", email: "legacy@example.test" },
        },
        actor: authState.actor,
        authTime: null,
    }),
}));
vi.mock("@/lib/authz/access-state", () => ({
    holderAccess: async () => ({
        ok: true,
        capabilities: authState.actor.capabilities,
    }),
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => orgState.orgUserId,
    isOrgScopeEnabled: () => orgState.orgUserId !== null,
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isAutoLearnOffered: async () => false,
    isLearnDeploymentAvailable: () => true,
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { GET, PUT } from "@/app/api/settings/user/route";
import { resolveDefaultProfile } from "@/lib/profiles/resolve";
import { ensureProfiles } from "@/lib/profiles/seed";
import { getDefaultProfile } from "@/lib/profiles/store";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function request(method: "GET" | "PUT", body?: Record<string, unknown>) {
    return new Request("https://app.example.test/api/settings/user", {
        method,
        ...(body
            ? {
                  body: JSON.stringify(body),
                  headers: { "Content-Type": "application/json" },
              }
            : {}),
    });
}

describeWithDatabase("legacy profile settings compatibility", () => {
    let database: TestPostgresDatabase | null = null;

    function databaseClient() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "profile_legacy_settings",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await databaseClient().insert(users).values({
            id: "legacy-profile-user",
            email: "legacy@example.test",
        });
    }, 120_000);

    beforeEach(async () => {
        orgState.orgUserId = null;
        authState.actor.kind = "user";
        authState.actor.capabilities = new Set<Capability>(["use"]);
        await databaseClient()
            .delete(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, "legacy-profile-user"));
        await databaseClient()
            .delete(userSettings)
            .where(eq(userSettings.userId, "legacy-profile-user"));
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("writes legacy automation changes into one new default-profile revision and reads them back", async () => {
        expect(
            (
                await PUT(
                    request("PUT", {
                        autoSummarize: true,
                    }),
                )
            ).status,
        ).toBe(200);

        const profile = await resolveDefaultProfile(
            "legacy-profile-user",
            "audio",
        );
        expect(profile.settings.steps.summary.automatic).toBe(true);
        expect(profile.profile.version).toBe(2);

        const response = await GET(request("GET"));
        expect(response.status).toBe(200);
        expect((await response.json()).autoSummarize).toBe(true);
    });

    it("keeps multi-pass preferences account-level", async () => {
        await ensureProfiles("legacy-profile-user");

        expect(
            (
                await PUT(
                    request("PUT", {
                        summaryMultiPass: true,
                        summaryMultiPassRounds: 5,
                        summaryMultiPassAuto: true,
                        summaryMergePrompt: "Account merge prompt",
                    }),
                )
            ).status,
        ).toBe(200);

        const profile = await resolveDefaultProfile(
            "legacy-profile-user",
            "audio",
        );
        expect(profile.settings.steps.summary.multiPass).toMatchObject({
            enabled: false,
            rounds: 3,
            automaticToo: false,
            mergePrompt: null,
        });
        const mailProfile = await getDefaultProfile(
            "legacy-profile-user",
            "mail",
            "legacy-profile-user",
        );
        if (!mailProfile) throw new Error("Mail profile was not seeded");
        expect(mailProfile.settings.steps.summary.multiPass).toMatchObject({
            enabled: false,
            rounds: 3,
            automaticToo: false,
            mergePrompt: null,
        });

        const response = await GET(request("GET"));
        expect(await response.json()).toMatchObject({
            summaryMultiPass: true,
            summaryMultiPassRounds: 5,
            summaryMultiPassAuto: true,
            summaryMergePrompt: "Account merge prompt",
        });
    });

    it("writes through when the real actor may edit an Organization profile", async () => {
        orgState.orgUserId = "legacy-profile-user";
        authState.actor.capabilities = new Set<Capability>([
            "use",
            "org.curate",
        ]);
        await ensureProfiles("legacy-profile-user");

        expect(
            (
                await PUT(
                    request("PUT", {
                        autoSummarize: true,
                    }),
                )
            ).status,
        ).toBe(200);

        const profile = await getDefaultProfile(
            "legacy-profile-user",
            "audio",
            "legacy-profile-user",
        );
        if (!profile) throw new Error("Organization profile was not seeded");
        expect(profile.settings.steps.summary.automatic).toBe(true);
        expect(profile.version).toBe(2);
    });

    it("saves account settings when the actor cannot edit an Organization profile", async () => {
        orgState.orgUserId = "legacy-profile-user";
        await ensureProfiles("legacy-profile-user");

        expect(
            (
                await PUT(
                    request("PUT", {
                        autoSummarize: true,
                    }),
                )
            ).status,
        ).toBe(200);

        const profile = await getDefaultProfile(
            "legacy-profile-user",
            "audio",
            "legacy-profile-user",
        );
        if (!profile) throw new Error("Organization profile was not seeded");
        expect(profile.settings.steps.summary.automatic).toBe(false);
        expect(profile.version).toBe(1);

        const [settings] = await databaseClient()
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, "legacy-profile-user"));
        expect(settings?.autoSummarize).toBe(true);
    });
});
