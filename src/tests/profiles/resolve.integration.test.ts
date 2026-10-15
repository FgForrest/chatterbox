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
    apiCredentials,
    chatterItems,
    itemProcessing,
    processingProfiles,
    userSettings,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { resolveStepProvider } from "@/lib/profiles/providers";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
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
            SELF_HOST_MODE: "shared" as "local" | "shared",
            ORG_ACCOUNT_EMAIL: "organization@example.test",
            ORG_ACCOUNT_PASSWORD: "password" as string | undefined,
            AUTHZ_MODE: "local" as "local" | "idp",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import {
    AssignedProfileUnavailableError,
    ProfileSelectionRequiredError,
    resolveItemProfile,
} from "@/lib/profiles/resolve";
import { resolveManualItemProfile } from "@/lib/profiles/resolve-manual";
import { ensureProfiles } from "@/lib/profiles/seed";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "profile-resolve-owner";
const ORG = "profile-resolve-org";
const ITEM = "profile-resolve-item";

describeWithDatabase("item profile resolution", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "profile_resolve",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "profile-owner@example.test" },
                { id: ORG, email: "organization@example.test", role: "org" },
            ]);
        await db().insert(chatterItems).values({
            id: ITEM,
            userId: OWNER,
            kind: "audio",
            title: "encrypted-title",
            occurredAt: new Date(),
        });
    }, 120_000);

    beforeEach(async () => {
        await db()
            .delete(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM));
        await db()
            .delete(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, OWNER));
        await db()
            .delete(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, ORG));
        await db().delete(userSettings).where(eq(userSettings.userId, OWNER));
        await db().delete(userSettings).where(eq(userSettings.userId, ORG));
        await db()
            .delete(apiCredentials)
            .where(eq(apiCredentials.userId, OWNER));
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("seeds and resolves the owner's channel default for the private view", async () => {
        const resolved = await resolveItemProfile(ITEM, "private", OWNER);

        expect(resolved.profile).toMatchObject({
            ownerUserId: OWNER,
            scope: "personal",
            channel: "audio",
            isDefault: true,
        });
        expect(resolved.revisionId).toBe(resolved.profile.currentRevisionId);
        expect(resolved.settings.steps.summary.preset).toBe("general");
    });

    it("keeps the organization scope while it is visible but not enabled", async () => {
        mockEnv.ORG_ACCOUNT_PASSWORD = undefined;
        try {
            await ensureProfiles(ORG);

            const profiles = await db()
                .select({ scope: processingProfiles.scope })
                .from(processingProfiles)
                .where(eq(processingProfiles.ownerUserId, ORG));

            expect(profiles.length).toBeGreaterThan(0);
            expect(new Set(profiles.map((profile) => profile.scope))).toEqual(
                new Set(["organization"]),
            );
        } finally {
            mockEnv.ORG_ACCOUNT_PASSWORD = "password";
        }
    });

    it("reads the frozen revision after its profile is archived", async () => {
        const assigned = await resolveItemProfile(ITEM, "private", OWNER);
        await db().insert(itemProcessing).values({
            itemId: ITEM,
            userId: OWNER,
            view: "private",
            profileId: assigned.profile.id,
            profileRevisionId: assigned.revisionId,
        });
        await db()
            .update(processingProfiles)
            .set({ archivedAt: new Date() })
            .where(eq(processingProfiles.id, assigned.profile.id));

        await expect(
            resolveItemProfile(ITEM, "private", OWNER),
        ).resolves.toMatchObject({
            revisionId: assigned.revisionId,
            assigned: true,
        });
    });

    it("uses the actor's default only for a manual run when the frozen Organization profile is unavailable", async () => {
        await ensureProfiles(OWNER);
        await ensureProfiles(ORG);
        const [organization] = await db()
            .select()
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, ORG),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            )
            .limit(1);
        if (!organization?.currentRevisionId) {
            throw new Error("organization profile was not seeded");
        }
        await db().insert(itemProcessing).values({
            itemId: ITEM,
            userId: OWNER,
            view: "private",
            profileId: organization.id,
            profileRevisionId: organization.currentRevisionId,
        });

        mockEnv.SELF_HOST_MODE = "local";
        try {
            await expect(
                resolveItemProfile(ITEM, "private", OWNER),
            ).rejects.toBeInstanceOf(AssignedProfileUnavailableError);
            await expect(
                resolveManualItemProfile(ITEM, "private", OWNER),
            ).resolves.toMatchObject({
                profile: { ownerUserId: OWNER, scope: "personal" },
                assigned: false,
            });
        } finally {
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });

    it("uses the Organization default instead of an assigned personal profile", async () => {
        await ensureProfiles(OWNER);
        const [personal] = await db()
            .select()
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, OWNER),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            );
        if (!personal) throw new Error("personal profile was not seeded");
        await db().insert(itemProcessing).values({
            itemId: ITEM,
            userId: OWNER,
            view: "org",
            profileId: personal.id,
        });

        const resolved = await resolveItemProfile(ITEM, "org", OWNER);

        expect(resolved.profile).toMatchObject({
            ownerUserId: ORG,
            scope: "organization",
            channel: "audio",
            isDefault: true,
        });
    });

    it("combines the Organization profile with the actor's unpinned provider", async () => {
        await db()
            .insert(apiCredentials)
            .values({
                id: "actor-summary-provider",
                userId: OWNER,
                provider: "openai",
                apiKey: encrypt("actor-key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });

        const profile = await resolveItemProfile(ITEM, "org", OWNER, OWNER);
        const provider = await resolveStepProvider({
            step: "summary",
            pin: profile.settings.steps.summary.provider,
            actorUserId: OWNER,
        });

        expect(profile.profile).toMatchObject({
            ownerUserId: ORG,
            scope: "organization",
        });
        expect(provider).toMatchObject({
            kind: "credential",
            payerUserId: OWNER,
            credential: {
                id: "actor-summary-provider",
                userId: OWNER,
            },
        });
    });

    it("returns a typed waiting error when the Organization has no default", async () => {
        await ensureProfiles(ORG);
        await db()
            .update(processingProfiles)
            .set({ isDefault: false })
            .where(
                and(
                    eq(processingProfiles.ownerUserId, ORG),
                    eq(processingProfiles.channel, "audio"),
                ),
            );

        await expect(resolveItemProfile(ITEM, "org", OWNER)).rejects.toEqual(
            expect.objectContaining({
                name: ProfileSelectionRequiredError.name,
                message: "Waiting for a curator to choose a profile",
            }),
        );
    });
});
