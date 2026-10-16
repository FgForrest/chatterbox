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
    processingProfileRevisions,
    processingProfiles,
    userSettings,
    users,
} from "@/db/schema";
import type { ActorContext } from "@/lib/authz/model";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

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
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "local" as "local" | "shared",
            ORG_ACCOUNT_EMAIL: undefined as string | undefined,
            ORG_ACCOUNT_PASSWORD: undefined as string | undefined,
            AUTHZ_MODE: "local" as "local" | "idp",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { decryptText } from "@/lib/encryption/fields";
import { ensureProfiles } from "@/lib/profiles/seed";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import {
    archiveProfile,
    createProfile,
    DefaultProfileArchiveError,
    duplicateProfile,
    getProfile,
    listProfiles,
    ProfileVersionConflictError,
    setDefaultProfile,
    updateProfile,
} from "@/lib/profiles/store";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const ALICE = "profiles-store-alice";
const BOB = "profiles-store-bob";

function actor(userId: string): ActorContext {
    return {
        kind: "user",
        actorId: userId,
        issuer: null,
        subject: null,
        capabilities: new Set(["use"]),
        clientId: null,
        clientPermissions: new Set(),
        verifiedAt: null,
    };
}

describeWithDatabase("profile store", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "profile_store",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "profiles-alice@example.test" },
                { id: BOB, email: "profiles-bob@example.test" },
            ]);
    }, 120_000);

    beforeEach(async () => {
        await db()
            .delete(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.scope, "personal"),
                    eq(processingProfiles.ownerUserId, ALICE),
                ),
            );
        await db()
            .delete(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, BOB));
        await db().delete(userSettings).where(eq(userSettings.userId, ALICE));
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("writes immutable revisions and rejects a stale version", async () => {
        const created = await createProfile({
            ownerUserId: ALICE,
            actor: actor(ALICE),
            scope: "personal",
            channel: "audio",
            name: "Interviews",
            description: "Interview processing",
            settings: defaultProfileSettings("audio"),
        });
        const changedSettings = defaultProfileSettings("audio");
        changedSettings.steps.summary.focus = "Hiring decisions";

        const updated = await updateProfile({
            ownerUserId: ALICE,
            profileId: created.id,
            actor: actor(ALICE),
            expectedVersion: 1,
            name: "Candidate interviews",
            settings: changedSettings,
        });

        expect(updated).toMatchObject({
            id: created.id,
            name: "Candidate interviews",
            version: 2,
            settings: changedSettings,
        });
        const revisions = await db()
            .select()
            .from(processingProfileRevisions)
            .where(eq(processingProfileRevisions.profileId, created.id))
            .orderBy(processingProfileRevisions.createdAt);
        expect(revisions).toHaveLength(2);
        expect(JSON.parse(decryptText(revisions[0]?.settings ?? "{}"))).toEqual(
            defaultProfileSettings("audio"),
        );
        expect(JSON.parse(decryptText(revisions[1]?.settings ?? "{}"))).toEqual(
            changedSettings,
        );

        await expect(
            updateProfile({
                ownerUserId: ALICE,
                profileId: created.id,
                actor: actor(ALICE),
                expectedVersion: 1,
                settings: defaultProfileSettings("audio"),
            }),
        ).rejects.toBeInstanceOf(ProfileVersionConflictError);
        expect(
            await db()
                .select()
                .from(processingProfileRevisions)
                .where(eq(processingProfileRevisions.profileId, created.id)),
        ).toHaveLength(2);
    });

    it("archives profiles and excludes them from ordinary reads", async () => {
        const created = await createProfile({
            ownerUserId: ALICE,
            actor: actor(ALICE),
            scope: "personal",
            channel: "mail",
            name: "Mail triage",
            settings: defaultProfileSettings("mail"),
        });

        await expect(
            archiveProfile({
                ownerUserId: ALICE,
                profileId: created.id,
                actor: actor(ALICE),
            }),
        ).resolves.toBe(true);
        await expect(getProfile(ALICE, created.id, ALICE)).resolves.toBeNull();
        expect(
            await getProfile(ALICE, created.id, ALICE, {
                includeArchived: true,
            }),
        ).toMatchObject({ id: created.id, isDefault: false });
    });

    it("refuses to archive the default profile", async () => {
        await ensureProfiles(ALICE);
        const defaults = await db()
            .select()
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, ALICE),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            );

        await expect(
            archiveProfile({
                ownerUserId: ALICE,
                profileId: defaults[0]?.id ?? "missing",
                actor: actor(ALICE),
            }),
        ).rejects.toBeInstanceOf(DefaultProfileArchiveError);
    });

    it("serializes parallel default switches without leaving zero or two defaults", async () => {
        await ensureProfiles(ALICE);
        const first = await createProfile({
            ownerUserId: ALICE,
            actor: actor(ALICE),
            scope: "personal",
            channel: "audio",
            name: "First candidate",
            settings: defaultProfileSettings("audio"),
        });
        const second = await createProfile({
            ownerUserId: ALICE,
            actor: actor(ALICE),
            scope: "personal",
            channel: "audio",
            name: "Second candidate",
            settings: defaultProfileSettings("audio"),
        });

        await Promise.all([
            setDefaultProfile({
                ownerUserId: ALICE,
                profileId: first.id,
                actor: actor(ALICE),
            }),
            setDefaultProfile({
                ownerUserId: ALICE,
                profileId: second.id,
                actor: actor(ALICE),
            }),
        ]);

        const defaults = await db()
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(
                and(
                    eq(processingProfiles.ownerUserId, ALICE),
                    eq(processingProfiles.channel, "audio"),
                    eq(processingProfiles.isDefault, true),
                ),
            );
        expect(defaults).toHaveLength(1);
        expect([first.id, second.id]).toContain(defaults[0]?.id);
    });

    it("duplicates into the actor's personal scope", async () => {
        const original = await createProfile({
            ownerUserId: ALICE,
            actor: actor(ALICE),
            scope: "personal",
            channel: "audio",
            name: "Calls",
            settings: defaultProfileSettings("audio"),
        });

        const duplicate = await duplicateProfile({
            sourceOwnerUserId: ALICE,
            profileId: original.id,
            actor: actor(ALICE),
        });

        expect(duplicate).toMatchObject({
            ownerUserId: ALICE,
            scope: "personal",
            channel: "audio",
            name: "Calls copy",
            isDefault: false,
            settings: original.settings,
        });
    });

    it("keeps every read and write owner-scoped", async () => {
        const created = await createProfile({
            ownerUserId: ALICE,
            actor: actor(ALICE),
            scope: "personal",
            channel: "audio",
            name: "Private",
            settings: defaultProfileSettings("audio"),
        });

        await expect(getProfile(BOB, created.id, BOB)).resolves.toBeNull();
        await expect(
            updateProfile({
                ownerUserId: BOB,
                profileId: created.id,
                actor: actor(BOB),
                expectedVersion: 1,
                name: "Stolen",
            }),
        ).resolves.toBeNull();
        await expect(
            archiveProfile({
                ownerUserId: BOB,
                profileId: created.id,
                actor: actor(BOB),
            }),
        ).resolves.toBe(false);
        expect(await getProfile(ALICE, created.id, ALICE)).toMatchObject({
            name: "Private",
            version: 1,
            archivedAt: null,
        });
    });

    it("searches decrypted names before paginating and filters channel and scope", async () => {
        for (const [name, channel] of [
            ["Weekly interview", "audio"],
            ["Interview mail", "mail"],
            ["General recording", "audio"],
        ] as const) {
            await createProfile({
                ownerUserId: ALICE,
                actor: actor(ALICE),
                scope: "personal",
                channel,
                name,
                settings: defaultProfileSettings(channel),
            });
        }

        const result = await listProfiles({
            ownerUserId: ALICE,
            actorUserId: ALICE,
            search: "interview",
            channel: "audio",
            scope: "personal",
            offset: 0,
            limit: 1,
        });
        expect(result.total).toBe(1);
        expect(result.items.map(({ name }) => name)).toEqual([
            "Weekly interview",
        ]);
    });

    it("serializes parallel seeding into exactly one complete set", async () => {
        await db().insert(userSettings).values({
            userId: ALICE,
            autoSummarizePreset: "meeting-notes",
        });

        await Promise.all([ensureProfiles(ALICE), ensureProfiles(ALICE)]);

        const profiles = await db()
            .select()
            .from(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, ALICE));
        const revisions = await db()
            .select()
            .from(processingProfileRevisions)
            .where(
                and(
                    eq(
                        processingProfileRevisions.profileId,
                        profiles[0]?.id ?? "",
                    ),
                    eq(
                        processingProfileRevisions.profileId,
                        profiles[0]?.id ?? "",
                    ),
                ),
            );
        const allRevisions = await db()
            .select()
            .from(processingProfileRevisions);

        expect(profiles).toHaveLength(3);
        expect(revisions).toHaveLength(1);
        expect(
            allRevisions.filter((revision) =>
                profiles.some((profile) => profile.id === revision.profileId),
            ),
        ).toHaveLength(3);
        expect(profiles.filter(({ isDefault }) => isDefault)).toHaveLength(2);
    });
});
