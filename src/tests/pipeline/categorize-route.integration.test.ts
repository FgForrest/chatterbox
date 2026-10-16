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
    mailPendingShares,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { loadPrivateItemProcessing } from "@/lib/pipeline/presentation";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, authState, enqueueExportPlansForUser, nudge } =
    vi.hoisted(() => {
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
            authState: { userId: "categorize-owner" },
            enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
            nudge: vi.fn(),
        };
    });

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: {
            id: authState.userId,
            email: `${authState.userId}@example.test`,
        },
        session: { id: `session-${authState.userId}` },
    }),
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptJsonField: vi.fn((value: unknown) => value),
    decryptText: vi.fn((value: string | null) => value),
    encryptJsonField: vi.fn((value: unknown) => value),
    encryptText: vi.fn((value: string | null) => value),
}));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "categorize-org@example.test",
        ORG_ACCOUNT_PASSWORD: "password",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser,
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import { POST as PREVIEW } from "@/app/api/recordings/[id]/categorize/preview/route";
import { POST } from "@/app/api/recordings/[id]/categorize/route";
import { POST as PROCESS_AGAIN } from "@/app/api/recordings/[id]/process-again/route";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const OWNER = "categorize-owner";
const OTHER = "categorize-other";
const ORG = "categorize-org";
const ITEM = "categorize-item";

function request(folderIds: string[], profileId?: string, manualOnly = false) {
    return new Request(
        `https://app.example.test/api/recordings/${ITEM}/categorize`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                folderIds,
                ...(profileId ? { profileId } : {}),
                ...(manualOnly ? { manualOnly: true } : {}),
            }),
        },
    );
}

function previewRequest(folderIds: string[]) {
    return new Request(
        `https://app.example.test/api/recordings/${ITEM}/categorize/preview`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderIds }),
        },
    );
}

function context() {
    return { params: Promise.resolve({ id: ITEM }) };
}

describeWithDatabase("categorize route", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database not ready");
        return database.db;
    }

    async function addFolder(input: {
        id: string;
        userId: string;
        parentId: string | null;
        kind?: "private" | "public" | "custom";
    }) {
        await db()
            .insert(recordingFolders)
            .values({
                ...input,
                name: input.id,
                nameHash: `hash-${input.id}`,
                kind: input.kind ?? "custom",
            });
    }

    async function addProfile(input: {
        id: string;
        ownerUserId: string;
        scope: "personal" | "organization";
        channel: "audio" | "mail";
        isDefault?: boolean;
    }) {
        const revisionId = `${input.id}-revision`;
        await db()
            .insert(processingProfiles)
            .values({
                ...input,
                name: input.id,
                currentRevisionId: revisionId,
                isDefault: input.isDefault ?? false,
                createdBy: input.ownerUserId,
                updatedBy: input.ownerUserId,
            });
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: revisionId,
                profileId: input.id,
                settings: JSON.stringify(defaultProfileSettings(input.channel)),
                createdBy: input.ownerUserId,
            });
    }

    async function addItem(kind: "audio" | "mail" = "audio") {
        await db()
            .insert(chatterItems)
            .values({
                id: ITEM,
                userId: OWNER,
                kind,
                title: "Item",
                occurredAt: new Date("2026-10-15T10:00:00Z"),
            });
    }

    async function placementIds() {
        return (
            await db()
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, ITEM),
                        eq(recordingFolderAssignments.userId, OWNER),
                    ),
                )
        ).map((row) => row.folderId);
    }

    async function organizationPlacementIds() {
        return (
            await db()
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .innerJoin(
                    recordingFolders,
                    eq(
                        recordingFolders.id,
                        recordingFolderAssignments.folderId,
                    ),
                )
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, ITEM),
                        eq(recordingFolders.userId, ORG),
                    ),
                )
        ).map((row) => row.folderId);
    }

    async function intentIds() {
        return (
            await db()
                .select({ folderId: mailPendingShares.folderId })
                .from(mailPendingShares)
                .where(
                    and(
                        eq(mailPendingShares.itemId, ITEM),
                        eq(mailPendingShares.userId, OWNER),
                    ),
                )
        ).map((row) => row.folderId);
    }

    async function processing() {
        const [row] = await db()
            .select()
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                    eq(itemProcessing.view, "private"),
                ),
            )
            .limit(1);
        return row;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "categorize_route",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        authState.userId = OWNER;
        enqueueExportPlansForUser.mockClear();
        nudge.mockClear();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "categorize-owner@example.test" },
                { id: OTHER, email: "categorize-other@example.test" },
                {
                    id: ORG,
                    email: "categorize-org@example.test",
                    role: "org",
                },
            ]);
        await addFolder({
            id: "personal-root",
            userId: OWNER,
            parentId: null,
            kind: "private",
        });
        await addFolder({
            id: "personal-a",
            userId: OWNER,
            parentId: "personal-root",
        });
        await addFolder({
            id: "personal-b",
            userId: OWNER,
            parentId: "personal-root",
        });
        await addFolder({
            id: "org-root",
            userId: ORG,
            parentId: null,
            kind: "public",
        });
        await addFolder({ id: "org-a", userId: ORG, parentId: "org-root" });
        await addFolder({ id: "org-b", userId: ORG, parentId: "org-root" });
        await addFolder({
            id: "other-root",
            userId: OTHER,
            parentId: null,
            kind: "private",
        });
        await addFolder({
            id: "other-a",
            userId: OTHER,
            parentId: "other-root",
        });
        await addProfile({
            id: "audio-a",
            ownerUserId: OWNER,
            scope: "personal",
            channel: "audio",
            isDefault: true,
        });
        await addProfile({
            id: "audio-b",
            ownerUserId: OWNER,
            scope: "personal",
            channel: "audio",
        });
        await addProfile({
            id: "mail-a",
            ownerUserId: OWNER,
            scope: "personal",
            channel: "mail",
        });
        await addProfile({
            id: "org-audio",
            ownerUserId: ORG,
            scope: "organization",
            channel: "audio",
        });
        await db()
            .insert(folderDefaultProfiles)
            .values([
                {
                    folderId: "personal-a",
                    channel: "audio",
                    profileId: "audio-a",
                },
                {
                    folderId: "personal-b",
                    channel: "audio",
                    profileId: "audio-b",
                },
                {
                    folderId: "org-a",
                    channel: "audio",
                    profileId: "org-audio",
                },
            ]);
    });

    it("creates a personal placement and freezes the resolved profile revision", async () => {
        await addItem();

        const response = await POST(request(["personal-a"]), context());

        expect(response.status).toBe(200);
        expect(await placementIds()).toEqual(["personal-a"]);
        expect(await intentIds()).toEqual([]);
        expect(await processing()).toMatchObject({
            profileId: "audio-a",
            profileRevisionId: "audio-a-revision",
            requestedGeneration: 1,
            phases: {
                categorize: expect.objectContaining({
                    state: "done",
                    reason: "categorized",
                    generation: 1,
                }),
            },
        });
        expect(enqueueExportPlansForUser).toHaveBeenCalledWith(OWNER);
        expect(nudge).toHaveBeenCalledOnce();
    });

    it("previews folder, Nothing automatic and conflicting resolutions without a write", async () => {
        await addItem();

        const folderResponse = await PREVIEW(
            previewRequest(["personal-a"]),
            context(),
        );
        expect(folderResponse.status).toBe(200);
        await expect(folderResponse.json()).resolves.toMatchObject({
            resolution: {
                status: "resolved",
                profile: { id: "audio-a" },
                manualOnly: false,
                source: "folder",
            },
        });

        await db()
            .update(folderDefaultProfiles)
            .set({ profileId: null, manualOnly: true })
            .where(eq(folderDefaultProfiles.folderId, "personal-a"));
        const manualResponse = await PREVIEW(
            previewRequest(["personal-a"]),
            context(),
        );
        await expect(manualResponse.json()).resolves.toMatchObject({
            resolution: {
                status: "resolved",
                profile: { id: "audio-a" },
                manualOnly: true,
                source: "folder",
            },
        });

        const chooseResponse = await PREVIEW(
            previewRequest(["personal-a", "personal-b"]),
            context(),
        );
        await expect(chooseResponse.json()).resolves.toMatchObject({
            resolution: { status: "choose" },
        });
        expect(await placementIds()).toEqual([]);
        expect(await intentIds()).toEqual([]);
        expect(await processing()).toBeUndefined();
        expect(enqueueExportPlansForUser).not.toHaveBeenCalled();
        expect(nudge).not.toHaveBeenCalled();
    });

    it("keeps previews owner-only and refuses roots and foreign folders", async () => {
        await addItem();

        expect(
            (await PREVIEW(previewRequest(["personal-root"]), context()))
                .status,
        ).toBe(400);
        expect(
            (await PREVIEW(previewRequest(["other-a"]), context())).status,
        ).toBe(404);

        authState.userId = OTHER;
        expect(
            (await PREVIEW(previewRequest(["personal-a"]), context())).status,
        ).toBe(404);
        expect(await placementIds()).toEqual([]);
        expect(await processing()).toBeUndefined();
    });

    it("keeps using the revision frozen at categorization after the profile changes", async () => {
        await addItem();
        expect((await POST(request(["personal-a"]), context())).status).toBe(
            200,
        );
        const beforeEdit = await processing();
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    ...beforeEdit?.phases,
                    summary: {
                        state: "done",
                        reason: "completed",
                        generation: 1,
                        at: "2026-10-15T10:01:00.000Z",
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                ),
            );
        await db()
            .insert(processingProfileRevisions)
            .values({
                id: "audio-a-revision-2",
                profileId: "audio-a",
                settings: JSON.stringify(defaultProfileSettings("audio")),
                createdBy: OWNER,
            });
        await db()
            .update(processingProfiles)
            .set({ currentRevisionId: "audio-a-revision-2" })
            .where(eq(processingProfiles.id, "audio-a"));

        const resolved = await resolveItemProfile(ITEM, "private", OWNER);

        expect(resolved.revisionId).toBe("audio-a-revision");
        expect((await processing())?.phases.summary).toMatchObject({
            state: "done",
            reason: "completed",
        });
    });

    it("records an Organization intent for mail without sharing it", async () => {
        await addItem("mail");

        const response = await POST(request(["org-a"], "mail-a"), context());

        expect(response.status).toBe(200);
        expect(await placementIds()).toEqual([]);
        expect(await intentIds()).toEqual(["org-a"]);
        expect(await processing()).toMatchObject({
            profileId: "mail-a",
            profileRevisionId: "mail-a-revision",
        });
        expect(enqueueExportPlansForUser).toHaveBeenCalledWith(OWNER);
        expect(enqueueExportPlansForUser).toHaveBeenCalledWith(ORG);
    });

    it("supports mixed personal and intended Organization placements", async () => {
        await addItem();

        const response = await POST(
            request(["personal-a", "org-a"], "audio-a"),
            context(),
        );

        expect(response.status).toBe(200);
        expect(await placementIds()).toEqual(["personal-a"]);
        expect(await intentIds()).toEqual(["org-a"]);
    });

    it("refuses roots", async () => {
        await addItem();

        const personal = await POST(request(["personal-root"]), context());
        const organization = await POST(request(["org-root"]), context());

        expect(personal.status).toBe(400);
        expect(organization.status).toBe(400);
        expect(await processing()).toBeUndefined();
    });

    it("returns the candidates when profile resolution needs the owner", async () => {
        await addItem();

        const response = await POST(
            request(["personal-a", "personal-b"]),
            context(),
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: "CONFLICT",
            details: {
                candidates: expect.arrayContaining([
                    expect.objectContaining({ id: "audio-a" }),
                    expect.objectContaining({ id: "audio-b" }),
                    { manualOnly: true },
                ]),
            },
        });
        expect(await placementIds()).toEqual([]);
    });

    it("accepts an explicit usable candidate", async () => {
        await addItem();

        const response = await POST(
            request(["personal-a", "personal-b"], "audio-b"),
            context(),
        );

        expect(response.status).toBe(200);
        expect(await processing()).toMatchObject({
            profileId: "audio-b",
            profileRevisionId: "audio-b-revision",
        });
    });

    it("fails loudly for an explicit profile that cannot be resolved", async () => {
        await addItem();

        const response = await POST(
            request(["personal-a"], "missing-profile"),
            context(),
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            code: "INVALID_INPUT",
            error: "The profile is not available for this item",
        });
        expect(await processing()).toBeUndefined();
    });

    it("bounds folder selections on categorize and preview", async () => {
        await addItem();
        const tooMany = Array.from({ length: 101 }, () => "personal-a");

        expect((await POST(request(tooMany), context())).status).toBe(400);
        expect((await PREVIEW(previewRequest(tooMany), context())).status).toBe(
            400,
        );
        expect(await processing()).toBeUndefined();
    });

    it("accepts Nothing automatic and freezes the owner's default profile", async () => {
        await addItem();

        const response = await POST(
            request(["personal-b"], undefined, true),
            context(),
        );

        expect(response.status).toBe(200);
        expect(await processing()).toMatchObject({
            profileId: "audio-a",
            profileRevisionId: "audio-a-revision",
            manualOnly: true,
            phases: {
                categorize: expect.objectContaining({ state: "done" }),
            },
        });
    });

    it("replaces managed placements but keeps the item's current profile", async () => {
        await addItem();
        expect(
            (await POST(request(["personal-a", "org-a"], "audio-a"), context()))
                .status,
        ).toBe(200);

        const response = await POST(
            request(["personal-b", "org-b"]),
            context(),
        );

        expect(response.status).toBe(200);
        expect(await placementIds()).toEqual(["personal-b"]);
        expect(await intentIds()).toEqual(["org-b"]);
        expect(await processing()).toMatchObject({
            profileId: "audio-a",
            profileRevisionId: "audio-a-revision",
            requestedGeneration: 2,
            phases: {
                categorize: expect.objectContaining({ generation: 2 }),
            },
        });
    });

    it("offers Process again after another profile is assigned and advances it explicitly", async () => {
        await addItem();
        expect((await POST(request(["personal-a"]), context())).status).toBe(
            200,
        );
        await db()
            .update(itemProcessing)
            .set({
                phases: {
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: 1,
                        at: "2026-10-15T10:00:00.000Z",
                    },
                    summary: {
                        state: "done",
                        reason: "completed",
                        generation: 1,
                        at: "2026-10-15T10:01:00.000Z",
                    },
                },
            })
            .where(
                and(
                    eq(itemProcessing.itemId, ITEM),
                    eq(itemProcessing.userId, OWNER),
                ),
            );

        expect(
            (await POST(request(["personal-b"], "audio-b"), context())).status,
        ).toBe(200);
        expect((await processing())?.phases.summary).toMatchObject({
            state: "outdated",
            reason: "profile_changed",
        });
        expect(
            (await loadPrivateItemProcessing(OWNER, ITEM))?.processAgain,
        ).toBe(true);

        const response = await PROCESS_AGAIN(
            new Request(
                `https://app.example.test/api/recordings/${ITEM}/process-again`,
                { method: "POST" },
            ),
            context(),
        );
        expect(response.status).toBe(200);
        expect(await processing()).toMatchObject({
            requestedGeneration: 3,
            phases: {
                categorize: expect.objectContaining({
                    reason: "process_again",
                    generation: 3,
                }),
            },
        });
    });

    it("offers Process again when a legacy item is filed later", async () => {
        await addItem();
        await db()
            .insert(itemProcessing)
            .values({
                itemId: ITEM,
                userId: OWNER,
                view: "private",
                phases: {
                    categorize: {
                        state: "skipped",
                        reason: "legacy",
                        generation: 0,
                        at: "2026-10-15T10:00:00.000Z",
                    },
                    summary: {
                        state: "done",
                        reason: "legacy",
                        generation: 0,
                        at: "2026-10-15T10:00:00.000Z",
                    },
                },
            });

        expect((await POST(request(["personal-a"]), context())).status).toBe(
            200,
        );
        expect(
            (await loadPrivateItemProcessing(OWNER, ITEM))?.processAgain,
        ).toBe(true);
    });

    it("does not let another user categorize the owner's item", async () => {
        await addItem();
        authState.userId = OTHER;

        const response = await POST(
            request(["personal-a"], "audio-a"),
            context(),
        );

        expect(response.status).toBe(404);
        expect(await processing()).toBeUndefined();
    });

    it("prunes a personal ancestor when its descendant is also selected", async () => {
        await addFolder({
            id: "personal-a-child",
            userId: OWNER,
            parentId: "personal-a",
        });
        await addItem();

        const response = await POST(
            request(["personal-a", "personal-a-child"], "audio-a"),
            context(),
        );

        expect(response.status).toBe(200);
        expect(await placementIds()).toEqual(["personal-a-child"]);
    });

    it("keeps personal and Organization root placements that the panel cannot manage", async () => {
        await addItem();
        await db()
            .insert(recordingFolderAssignments)
            .values([
                {
                    userId: OWNER,
                    itemId: ITEM,
                    folderId: "personal-root",
                },
                { userId: OWNER, itemId: ITEM, folderId: "org-root" },
            ]);

        const response = await POST(request(["personal-a"]), context());

        expect(response.status).toBe(200);
        expect((await placementIds()).sort()).toEqual(
            ["org-root", "personal-a", "personal-root"].sort(),
        );
        expect(await organizationPlacementIds()).toEqual(["org-root"]);
    });

    it("keeps an existing Organization placement when recategorizing", async () => {
        await addItem();
        await db()
            .insert(recordingFolderAssignments)
            .values({ userId: OWNER, itemId: ITEM, folderId: "org-a" });

        const response = await POST(
            request(["personal-b", "org-a", "org-b"], "audio-a"),
            context(),
        );

        expect(response.status).toBe(200);
        expect((await placementIds()).sort()).toEqual(
            ["org-a", "personal-b"].sort(),
        );
        expect(await organizationPlacementIds()).toEqual(["org-a"]);
        expect(await intentIds()).toEqual(["org-b"]);
    });

    it("refuses to omit an existing Organization placement", async () => {
        await addItem();
        await db()
            .insert(recordingFolderAssignments)
            .values({ userId: OWNER, itemId: ITEM, folderId: "org-a" });

        const response = await POST(
            request(["personal-b"], "audio-a"),
            context(),
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: "CONFLICT",
            error: "Unshare it from the Organization folder first",
        });
        expect(await organizationPlacementIds()).toEqual(["org-a"]);
        expect(await placementIds()).toEqual(["org-a"]);
        expect(await processing()).toBeUndefined();
    });
});
