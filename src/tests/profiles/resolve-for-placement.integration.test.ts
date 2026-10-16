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
    chatterItems,
    folderDefaultProfiles,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
    recordingFolders,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    defaultProfileSettings,
    type ProfileChannel,
} from "@/lib/profiles/settings";
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

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ORG_ACCOUNT_PASSWORD: "password",
        BETTER_AUTH_SECRET: "placement-test-secret",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "placement-org",
    isOrgAccount: async (userId: string) => userId === "placement-org",
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
}));
vi.mock("@/lib/identity/factory", () => ({
    isIdpAuthorization: () => false,
}));

import {
    folderDefaultProfile,
    resolveProfileForPlacements,
} from "@/lib/profiles/resolve-for-placement";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "placement-owner";
const ORG = "placement-org";
const ITEM = "placement-item";

describeWithDatabase("profile resolution for placements", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function addFolder(input: {
        id: string;
        ownerUserId?: string;
        parentId: string | null;
        kind?: "private" | "public" | "custom";
    }) {
        await db()
            .insert(recordingFolders)
            .values({
                id: input.id,
                userId: input.ownerUserId ?? OWNER,
                parentId: input.parentId,
                name: encryptText(input.id),
                nameHash: lookupHash(input.id),
                kind: input.kind ?? "custom",
            });
    }

    async function addProfile(input: {
        id: string;
        ownerUserId?: string;
        scope?: "personal" | "organization";
        channel?: ProfileChannel;
        archived?: boolean;
        isDefault?: boolean;
    }) {
        const channel = input.channel ?? "audio";
        const revisionId = `${input.id}-revision`;
        await db()
            .insert(processingProfiles)
            .values({
                id: input.id,
                ownerUserId: input.ownerUserId ?? OWNER,
                scope: input.scope ?? "personal",
                channel,
                name: encryptText(input.id),
                currentRevisionId: revisionId,
                createdBy: input.ownerUserId ?? OWNER,
                updatedBy: input.ownerUserId ?? OWNER,
                archivedAt: input.archived ? new Date() : null,
                isDefault: input.isDefault ?? false,
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: revisionId,
                profileId: input.id,
                settings: encryptText(
                    JSON.stringify(defaultProfileSettings(channel)),
                ),
                createdBy: input.ownerUserId ?? OWNER,
            });
    }

    async function setFolderDefault(folderId: string, profileId: string) {
        await db().insert(folderDefaultProfiles).values({
            folderId,
            channel: "audio",
            profileId,
        });
    }

    async function setFolderManualOnly(folderId: string) {
        await db().insert(folderDefaultProfiles).values({
            folderId,
            channel: "audio",
            profileId: null,
            manualOnly: true,
        });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "placement_profiles",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: ORG, email: "org@example.test", role: "org" },
            ]);
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM,
                userId: OWNER,
                kind: "audio",
                title: encryptText("Item"),
                occurredAt: new Date(),
            });
    }, 120_000);

    beforeEach(async () => {
        await db().delete(folderDefaultProfiles);
        await db()
            .delete(itemProcessing)
            .where(eq(itemProcessing.itemId, ITEM));
        await db().delete(recordingFolders);
        await db().delete(processingProfiles);
        await addFolder({
            id: "private-root",
            parentId: null,
            kind: "private",
        });
        await addFolder({ id: "parent", parentId: "private-root" });
        await addFolder({ id: "first", parentId: "parent" });
        await addFolder({ id: "second", parentId: "private-root" });
        await addFolder({
            id: "org-root",
            ownerUserId: ORG,
            parentId: null,
            kind: "public",
        });
        await addFolder({
            id: "org-folder",
            ownerUserId: ORG,
            parentId: "org-root",
        });
        await addProfile({
            id: "org-mail-guard",
            ownerUserId: ORG,
            scope: "organization",
            channel: "mail",
        });
    });

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("uses a folder's own default", async () => {
        await addProfile({ id: "own" });
        await setFolderDefault("first", "own");

        expect(await folderDefaultProfile("first", "audio")).toMatchObject({
            id: "own",
        });
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "own" },
            manualOnly: false,
        });
    });

    it("inherits the nearest usable ancestor default but not a root default", async () => {
        await addProfile({ id: "ancestor" });
        await setFolderDefault("parent", "ancestor");
        expect(await folderDefaultProfile("first", "audio")).toMatchObject({
            id: "ancestor",
        });

        await db().delete(folderDefaultProfiles);
        await setFolderDefault("private-root", "ancestor");
        expect(await folderDefaultProfile("first", "audio")).toBeNull();
    });

    it("resolves several placements with the same default", async () => {
        await addProfile({ id: "shared" });
        await setFolderDefault("parent", "shared");
        await setFolderDefault("second", "shared");

        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first", "second"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "shared" },
            manualOnly: false,
        });
    });

    it("asks when several placements have different defaults", async () => {
        await addProfile({ id: "one" });
        await addProfile({ id: "two" });
        await setFolderDefault("first", "one");
        await setFolderDefault("second", "two");

        const result = await resolveProfileForPlacements({
            ownerUserId: OWNER,
            itemId: ITEM,
            channel: "audio",
            folderIds: ["first", "second"],
            view: "private",
        });
        expect(result.status).toBe("choose");
        if (result.status === "choose") {
            expect(
                result.candidates
                    .filter((candidate) => candidate.kind === "profile")
                    .map(({ profile }) => profile.id)
                    .sort(),
            ).toEqual(["one", "two"]);
            expect(result.candidates).toContainEqual({ kind: "manual_only" });
        }
    });

    it("resolves an own or inherited Nothing automatic default", async () => {
        await addProfile({ id: "owner-default", isDefault: true });
        await setFolderManualOnly("first");

        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "owner-default" },
            manualOnly: true,
        });

        await db().delete(folderDefaultProfiles);
        await setFolderManualOnly("parent");
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "owner-default" },
            manualOnly: true,
        });
    });

    it("asks when profile and Nothing automatic placement defaults conflict", async () => {
        await addProfile({ id: "one", isDefault: true });
        await setFolderDefault("first", "one");
        await setFolderManualOnly("second");

        const result = await resolveProfileForPlacements({
            ownerUserId: OWNER,
            itemId: ITEM,
            channel: "audio",
            folderIds: ["first", "second"],
            view: "private",
        });

        expect(result.status).toBe("choose");
        if (result.status === "choose") {
            expect(result.candidates).toContainEqual({ kind: "manual_only" });
            expect(result.candidates).toContainEqual({
                kind: "profile",
                profile: expect.objectContaining({ id: "one" }),
            });
        }
    });

    it("uses the only usable channel profile when no folder has a default", async () => {
        await addProfile({ id: "only" });
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "only" },
        });
    });

    it("uses the owner's default when no folder default exists", async () => {
        await addProfile({ id: "one", isDefault: true });
        await addProfile({ id: "two" });
        await addProfile({
            id: "org-choice",
            ownerUserId: ORG,
            scope: "organization",
        });
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "one" },
            manualOnly: false,
        });
    });

    it("ignores an archived folder default", async () => {
        await addProfile({ id: "archived", archived: true });
        await addProfile({ id: "live" });
        await setFolderDefault("first", "archived");
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["first"],
                view: "private",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "live" },
            manualOnly: false,
        });
    });

    it("uses the item's Organization profile on the Organization view", async () => {
        await addProfile({
            id: "org-item",
            ownerUserId: ORG,
            scope: "organization",
        });
        await db().insert(itemProcessing).values({
            itemId: ITEM,
            userId: OWNER,
            view: "private",
            profileId: "org-item",
        });
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["org-folder"],
                view: "org",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "org-item", scope: "organization" },
            manualOnly: false,
        });
    });

    it("uses the Organization folder default on the Organization view", async () => {
        await addProfile({
            id: "org-default",
            ownerUserId: ORG,
            scope: "organization",
        });
        await setFolderDefault("org-folder", "org-default");
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["org-folder"],
                view: "org",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "org-default", scope: "organization" },
            manualOnly: false,
        });
    });

    it("falls back to the Organization account's default", async () => {
        await addProfile({
            id: "org-default",
            ownerUserId: ORG,
            scope: "organization",
            isDefault: true,
        });
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["org-folder"],
                view: "org",
            }),
        ).resolves.toMatchObject({
            status: "resolved",
            profile: { id: "org-default", scope: "organization" },
            manualOnly: false,
        });
    });

    it("waits for a curator when the Organization view has only a personal default", async () => {
        await addProfile({ id: "personal" });
        await db().insert(itemProcessing).values({
            itemId: ITEM,
            userId: OWNER,
            view: "private",
            profileId: "personal",
        });
        await expect(
            resolveProfileForPlacements({
                ownerUserId: OWNER,
                itemId: ITEM,
                channel: "audio",
                folderIds: ["org-folder"],
                view: "org",
            }),
        ).resolves.toEqual({ status: "waiting_for_curator" });
    });

    it("keeps item reads scoped to the supplied owner", async () => {
        await addProfile({
            id: "org-item",
            ownerUserId: ORG,
            scope: "organization",
        });
        await db().insert(itemProcessing).values({
            itemId: ITEM,
            userId: OWNER,
            view: "private",
            profileId: "org-item",
        });
        const result = await resolveProfileForPlacements({
            ownerUserId: "someone-else",
            itemId: ITEM,
            channel: "audio",
            folderIds: ["org-folder"],
            view: "org",
        });
        expect(result).toEqual({ status: "waiting_for_curator" });
        expect(
            await db()
                .select()
                .from(itemProcessing)
                .where(
                    and(
                        eq(itemProcessing.itemId, ITEM),
                        eq(itemProcessing.userId, OWNER),
                    ),
                ),
        ).toHaveLength(1);
    });
});
