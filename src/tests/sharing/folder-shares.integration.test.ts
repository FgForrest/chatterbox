import { and, eq, sql } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { z } from "zod";
import { PATCH as folderAction } from "@/app/api/folder-shares/[id]/route";
import { POST as restoreRoute } from "@/app/api/folder-shares/restore/route";
import { PUT as settingsRoute } from "@/app/api/folders/[id]/default-profiles/route";
import {
    GET as exportsGet,
    POST as exportsPost,
} from "@/app/api/folders/[id]/exports/route";
import {
    GET as addressesGet,
    PUT as addressesPut,
} from "@/app/api/folders/[id]/mail-addresses/route";
import {
    DELETE as deleteRoute,
    PATCH as renameRoute,
} from "@/app/api/folders/[id]/route";
import {
    POST as inviteRoute,
    GET as listRoute,
} from "@/app/api/folders/[id]/shares/route";
import { POST as synchronizePost } from "@/app/api/folders/[id]/synchronize/route";
import { POST as createRoute } from "@/app/api/folders/route";
import { DELETE as unfileMeetingRoute } from "@/app/api/meetings/[id]/folders/[folderId]/route";
import { POST as categorizePost } from "@/app/api/recordings/[id]/categorize/route";
import { GET as readCorrections } from "@/app/api/recordings/[id]/corrections/route";
import {
    POST as assignRoute,
    DELETE as unfileRoute,
} from "@/app/api/recordings/[id]/folders/route";
import { GET as readSpeakers } from "@/app/api/recordings/[id]/speakers/route";
import { GET as invitationsRoute } from "@/app/api/shares/route";
import { GET as recorderFolders } from "@/app/api/v1/recorder/folders/route";
import {
    isItemReceived,
    listOutgoingSharedItemIds,
    receivedItemCondition,
} from "@/db/queries/item-shares";
import {
    accounts,
    asyncJobs,
    chatterItems,
    folderDefaultProfiles,
    folderShares,
    itemProcessing,
    itemShares,
    knowledgeEntities,
    mailAddresses,
    mailMessages,
    people,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrections,
    userAccessStates,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { archivedItemCondition } from "@/lib/export/archive-scope";
import { collectArchivedFolderShares } from "@/lib/export/folder-shares";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import { folderCondition } from "@/lib/folders/condition";
import {
    addRecordingToFolder,
    assertCategorizableFolder,
    assertCategorizableFolders,
    deleteFolder,
    listExportFolderOrganization,
    listFolderOrganization,
    listPersonalFolderOrganization,
    listRecordingFolderTrees,
    moveFolder,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
    renameFolder,
} from "@/lib/folders/folders";
import * as knowledgeLoader from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { resolveMailAccess } from "@/lib/mail/access";
import { localPartHash } from "@/lib/mail/hash";
import { loadReceivedMailRows } from "@/lib/mail/list";
import { resolveCaller } from "@/lib/mcp/caller";
import { mcpItemCondition, recordingViewFor } from "@/lib/mcp/scope";
import { ALL_TOOLS } from "@/lib/mcp/tools";
import {
    attachAgenda,
    attachArrivingRecordingInTx,
} from "@/lib/meetings/attachment";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addPoint,
    getMeeting,
    listMeetings,
    patchMeeting,
    prepareMeeting,
} from "@/lib/meetings/service";
import {
    requestArrivalInTx,
    resolveArrivalProfile,
} from "@/lib/pipeline/arrival";
import { loadPrivateCategorizationPanel } from "@/lib/pipeline/categorization-presentation";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { createProfile, setDefaultProfile } from "@/lib/profiles/store";
import { searchApp } from "@/lib/search/app-search";
import { searchItems } from "@/lib/search/item-search";
import {
    requireRecordingView,
    resolveRecordingAccess,
} from "@/lib/sharing/access";
import {
    changeFolderShare,
    inviteToFolder,
    listFolderShares,
    listMyFolderInvitations,
    listReceivedFolderOrganization,
} from "@/lib/sharing/folder-shares";
import {
    changePersonShare,
    findShareRecipients,
    inviteToItem,
} from "@/lib/sharing/person-shares";
import { restoreArchivedFolderShares } from "@/lib/sharing/restore-folder-shares";
import { assertMayChange } from "@/lib/sharing/writer";
import { taskViewer } from "@/lib/tasks/access";
import {
    addTask,
    countNewTasks,
    createPersonalTask,
    followTask,
    listRecordingTasks,
    listTasks,
    markTasksSeen,
    updateTask,
} from "@/lib/tasks/tasks";
import { localActor } from "@/tests/helpers/session-actor";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    attributeSpeaker,
    insertRecording,
    insertTranscript,
    serviceCaller,
    userCaller,
} from "@/tests/mcp/fixtures";

const { ref, mockEnv, events, email } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
    events: vi.fn().mockResolvedValue(undefined),
    email: vi.fn().mockResolvedValue(undefined),
    mockEnv: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        ORG_ACCOUNT_EMAIL: "organization@example.com",
        ORG_ACCOUNT_PASSWORD: "demo-password",
        AUTHZ_MODE: "local",
        MCP_ALLOWED_CLIENTS: [],
        MCP_SERVICE_CLIENTS: [],
        MCP_AUDIENCE: "chatterbox-mcp",
        KNOWLEDGE_MEMORY_MB: 64,
        MAIL_DOMAIN: "mail.example.com",
        FILESYSTEM_EXPORT_ROOT: "/tmp/folder-share-exports",
        MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
        APP_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "demo-secret-demo-secret-demo-secret",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get: (_, key) => {
                const value = ref.current?.[key];
                return typeof value === "function"
                    ? value.bind(ref.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async () => ({
        authn: { user: { id: "receiver" } },
    }),
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/events/personal", () => ({ notifyPersonShareChanged: events }));
vi.mock("@/lib/org/events", () => ({
    notifyOrgChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: email,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async (actor: { actorId: string }) =>
        ["curator", "organization"].includes(actor.actorId),
    userCuratesOrganizationNow: async (id: string) =>
        ["curator", "organization"].includes(id),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async (request: Request) => ({
        user: {
            id: request.headers.get("x-test-user") ?? "receiver",
            email: "lena@example.com",
        },
    }),
    requireApiSessionActor: async (request: Request) => {
        const id = request.headers.get("x-test-user") ?? "receiver";
        return {
            session: { user: { id, email: "lena@example.com" } },
            actor: localActor(id),
            authTime: null,
        };
    },
}));

const url = getTestDatabaseUrl();
describe.skipIf(!url)("live folder sharing (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "folder_shares");
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        mockEnv.IS_HOSTED = false;
        mockEnv.SELF_HOST_MODE = "shared";
        mockEnv.AUTHZ_MODE = "local";
        events.mockClear();
        email.mockClear();
        await database.db.delete(mailAddresses);
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: "owner", email: "alex@example.com", name: "Alex Morgan" },
            { id: "receiver", email: "lena@example.com", name: "Lena Fischer" },
            { id: "other", email: "priya@example.com", name: "Priya Raman" },
            { id: "curator", email: "sam@example.com", name: "Sam Okafor" },
            {
                id: "organization",
                email: "organization@example.com",
                role: "org",
            },
        ]);
        await database.db.insert(recordingFolders).values([
            {
                id: "owner-root",
                userId: "owner",
                name: encryptText("Private"),
                nameHash: "private",
                kind: "private",
            },
            {
                id: "source",
                userId: "owner",
                parentId: "owner-root",
                name: encryptText("Research"),
                nameHash: "research",
            },
            {
                id: "child",
                userId: "owner",
                parentId: "source",
                name: encryptText("Unrelated private context"),
                nameHash: "child",
            },
            {
                id: "elsewhere",
                userId: "owner",
                parentId: "owner-root",
                name: encryptText("Elsewhere"),
                nameHash: "elsewhere",
            },
            {
                id: "receiver-root",
                userId: "receiver",
                name: encryptText("Private"),
                nameHash: "private",
                kind: "private",
            },
            {
                id: "my-folder",
                userId: "receiver",
                parentId: "receiver-root",
                name: encryptText("Projects"),
                nameHash: "projects",
            },
            {
                id: "org-root",
                userId: "organization",
                name: encryptText("Organization"),
                nameHash: "org",
                kind: "public",
            },
            {
                id: "org-folder",
                userId: "organization",
                parentId: "org-root",
                name: encryptText("Team"),
                nameHash: "team",
            },
        ]);
        for (const id of ["audio", "nested", "later"])
            await insertRecording(database.db, {
                id,
                userId: "owner",
                title: `Project ${id}`,
            });
        await database.db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Project email"),
            occurredAt: new Date(),
        });
        await database.db.insert(mailMessages).values({
            id: "mail",
            userId: "owner",
            rawHash: "demo-mail",
            receivedAt: new Date(),
            sizeBytes: 100,
            auth: encryptJsonField({ dkim: [], spf: null, arc: null }),
            senderVerified: true,
        });
        await database.db.insert(recordingFolderAssignments).values([
            { userId: "owner", itemId: "audio", folderId: "source" },
            { userId: "owner", itemId: "mail", folderId: "source" },
            { userId: "owner", itemId: "nested", folderId: "child" },
        ]);
    });
    const request = (
        path: string,
        method: string,
        body?: unknown,
        user = "receiver",
    ) =>
        new Request(`http://localhost/api/${path}`, {
            method,
            headers: {
                "Content-Type": "application/json",
                "x-test-user": user,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    const context = (id = "source") => ({ params: Promise.resolve({ id }) });
    const invite = async () =>
        (await inviteToFolder("owner", "source", ["receiver"]))[0];
    const accept = async () => {
        const share = await invite();
        await changeFolderShare("receiver", share.id, {
            action: "accept",
            version: share.version,
            name: "My research",
            parentId: "my-folder",
        });
        return share;
    };
    const visibleIds = async (viewer = "receiver") =>
        (
            await database.db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(receivedItemCondition(viewer))
        )
            .map((row) => row.id)
            .sort();

    it("requires acceptance and reveals no owner tree beyond the shared folder", async () => {
        const share = await invite();
        expect(await visibleIds()).toEqual([]);
        expect((await listMyFolderInvitations("receiver"))[0]).toMatchObject({
            kind: "folder",
            title: "Research",
        });
        const pending = await invitationsRoute(request("shares", "GET"));
        expect(await pending.text()).not.toContain("Unrelated private context");
        await changeFolderShare("receiver", share.id, {
            action: "accept",
            version: share.version,
        });
        expect(await visibleIds()).toEqual(["audio", "mail"]);
        const tree = await listFolderOrganization("receiver");
        expect(
            tree.folders.find((folder) => folder.receivedFolder),
        ).toMatchObject({
            name: "Research",
            receivedFolder: {
                originalName: "Research",
                ownerName: "Alex Morgan",
            },
        });
        expect(JSON.stringify(tree)).not.toContain("Unrelated private context");
        expect((await resolveRecordingAccess("receiver", "audio"))?.role).toBe(
            "receiver",
        );
        expect((await resolveMailAccess("receiver", "mail"))?.role).toBe(
            "receiver",
        );
    });
    it("shares live direct items of both kinds, and withdraws them immediately", async () => {
        await accept();
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "later",
            folderId: "source",
        });
        expect(await visibleIds()).toEqual(["audio", "later", "mail"]);
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "audio",
            folderId: "source",
        });
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "mail",
            folderId: "source",
        });
        expect(await visibleIds()).toEqual(["later"]);
        expect(await resolveRecordingAccess("receiver", "audio")).toBeNull();
        expect(await resolveMailAccess("receiver", "mail")).toBeNull();
        expect(events).toHaveBeenCalledWith("receiver");
    });
    it("never inherits a subfolder's items or its invitation", async () => {
        await accept();
        expect(await isItemReceived("receiver", "nested")).toBe(false);
        expect(await listMyFolderInvitations("receiver")).toEqual([]);
        const tree = await listFolderOrganization("receiver");
        const attached = tree.folders.find((folder) => folder.receivedFolder);
        expect(
            tree.folders.filter((folder) => folder.parentId === attached?.id),
        ).toEqual([]);
    });
    it("keeps one row for direct and inherited access and revokes each independently", async () => {
        await accept();
        const [direct] = await inviteToItem("owner", "audio", ["receiver"]);
        await changePersonShare("receiver", direct.id, {
            action: "accept",
            version: direct.version,
            folderId: "my-folder",
        });
        expect(
            (await visibleIds()).filter((id) => id === "audio"),
        ).toHaveLength(1);
        await changePersonShare("receiver", direct.id, {
            action: "remove",
            version: direct.version + 1,
        });
        expect(await isItemReceived("receiver", "audio")).toBe(true);
        const [share] = await listFolderShares("owner", "source");
        await changeFolderShare("receiver", share.id, {
            action: "remove",
            version: share.version,
        });
        expect(await isItemReceived("receiver", "audio")).toBe(false);
    });
    it("stores the receiver name encrypted and never creates folders or assignments for them", async () => {
        await accept();
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(node).toMatchObject({
            userId: "receiver",
            parentId: "my-folder",
        });
        expect(node.name).not.toBe("My research");
        expect(decryptText(node.name)).toBe("My research");
        expect(
            await database.db
                .select()
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.userId, "receiver"),
                        eq(recordingFolders.name, "My research"),
                    ),
                ),
        ).toEqual([]);
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.userId, "receiver")),
        ).toEqual([]);
        expect(await database.db.select().from(itemShares)).toEqual([]);
    });
    it("renames and moves only the attachment, with stale versions refused", async () => {
        const share = await accept();
        await changeFolderShare("receiver", share.id, {
            action: "rename",
            version: 1,
            name: "Local name",
        });
        await expect(
            changeFolderShare("receiver", share.id, {
                action: "move",
                version: 1,
                parentId: null,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await changeFolderShare("receiver", share.id, {
            action: "move",
            version: 2,
            parentId: null,
        });
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(decryptText(node.name)).toBe("Local name");
        expect(node.parentId).toBeNull();
        expect((await listFolderShares("owner", "source"))[0].version).toBe(3);
        const [source] = await database.db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, "source"));
        expect(decryptText(source.name)).toBe("Research");
    });
    it("keeps the attachment's parent when a move only reorders", async () => {
        const share = await accept();
        await changeFolderShare("receiver", share.id, {
            action: "move",
            version: 1,
            sortOrder: 7,
        });
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(node).toMatchObject({ parentId: "my-folder", sortOrder: 7 });
    });
    it("refuses owner, Organization, attachment and unknown parent IDs for acceptance and movement", async () => {
        const share = await invite();
        for (const parentId of ["source", "org-folder", "missing"])
            await expect(
                changeFolderShare("receiver", share.id, {
                    action: "accept",
                    version: 0,
                    parentId,
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
        await changeFolderShare("receiver", share.id, {
            action: "accept",
            version: 0,
        });
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        for (const parentId of ["source", "org-folder", node.id])
            await expect(
                changeFolderShare("receiver", share.id, {
                    action: "move",
                    version: 1,
                    parentId,
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("keeps the receiver name after owner rename and retains sharing after a private move", async () => {
        await accept();
        await renameFolder({
            userId: "owner",
            folderId: "source",
            name: "Owner renamed",
        });
        await moveFolder({
            userId: "owner",
            folderId: "source",
            parentId: "elsewhere",
        });
        const tree = await listFolderOrganization("receiver");
        expect(
            tree.folders.find((folder) => folder.receivedFolder),
        ).toMatchObject({
            name: "My research",
            receivedFolder: { originalName: "Owner renamed" },
        });
        expect(await visibleIds()).toEqual(["audio", "mail"]);
    });
    it("removal ends the share and owner can invite again without the old attachment", async () => {
        const share = await accept();
        await changeFolderShare("receiver", share.id, {
            action: "remove",
            version: 1,
        });
        expect((await listFolderShares("owner", "source"))[0].state).toBe(
            "removed",
        );
        expect(
            (await listFolderOrganization("receiver")).folders.some(
                (folder) => folder.receivedFolder,
            ),
        ).toBe(false);
        expect(await visibleIds()).toEqual([]);
        const [again] = await inviteToFolder("owner", "source", ["receiver"]);
        expect(again.state).toBe("pending");
        expect(
            await database.db.select().from(receivedFolderAttachments),
        ).toEqual([]);
    });
    it("declines, re-invites, cancels, and rejects acceptance after cancellation", async () => {
        let share = await invite();
        await changeFolderShare("receiver", share.id, {
            action: "decline",
            version: 0,
        });
        expect((await listFolderShares("owner", "source"))[0].state).toBe(
            "declined",
        );
        [share] = await inviteToFolder("owner", "source", ["receiver"]);
        await changeFolderShare("owner", share.id, {
            action: "cancel",
            version: share.version,
        });
        await expect(
            changeFolderShare("receiver", share.id, {
                action: "accept",
                version: share.version,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await visibleIds()).toEqual([]);
    });
    it("serializes double acceptance and owner cancellation races", async () => {
        const share = await invite();
        const results = await Promise.allSettled([
            changeFolderShare("receiver", share.id, {
                action: "accept",
                version: 0,
            }),
            changeFolderShare("receiver", share.id, {
                action: "accept",
                version: 0,
            }),
        ]);
        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            await database.db.select().from(receivedFolderAttachments),
        ).toHaveLength(1);
    });
    it("serializes owner cancellation against acceptance", async () => {
        const share = await invite();
        const [accepted, cancelled] = await Promise.allSettled([
            changeFolderShare("receiver", share.id, {
                action: "accept",
                version: 0,
            }),
            changeFolderShare("owner", share.id, {
                action: "cancel",
                version: 0,
            }),
        ]);
        expect(
            [accepted, cancelled].filter(
                (result) => result.status === "fulfilled",
            ),
        ).toHaveLength(1);
        const attachments = await database.db
            .select()
            .from(receivedFolderAttachments);
        const shares = await database.db.select().from(folderShares);
        if (accepted.status === "fulfilled") {
            expect(attachments).toHaveLength(1);
            expect(shares.map((row) => row.state)).toEqual(["accepted"]);
        } else {
            expect(attachments).toEqual([]);
            expect(shares).toEqual([]);
            expect(await visibleIds()).toEqual([]);
        }
    });
    it("refreshes receivers only after an automatic arrival commits", async () => {
        await accept();
        const notifications: unknown[] = [];
        const listener = await database.sql.listen(
            "riffado_personal",
            (payload) => {
                notifications.push(JSON.parse(payload));
            },
        );
        try {
            await database.db.transaction(async (tx) => {
                await requestArrivalInTx(tx, {
                    itemId: "later",
                    userId: "owner",
                    folder: {
                        folderId: "source",
                        ownerId: "owner",
                        scope: "personal",
                    },
                });
                expect(notifications).toEqual([]);
            });
            await vi.waitFor(() =>
                expect(notifications).toEqual([
                    { type: "share", userId: "receiver" },
                ]),
            );
            expect(await visibleIds()).toEqual(["audio", "later", "mail"]);
            await removeRecordingFromFolder({
                userId: "owner",
                recordingId: "later",
                folderId: "source",
            });
            await vi.waitFor(() => expect(notifications).toHaveLength(2));
            expect(notifications[1]).toEqual({
                type: "share",
                userId: "receiver",
            });
            expect(await visibleIds()).toEqual(["audio", "mail"]);
        } finally {
            await listener.unlisten();
        }
    });
    it("notifies only accepted receivers of the item's direct folder on arrival and placement", async () => {
        await accept();
        const [unrelated] = await inviteToFolder("owner", "elsewhere", [
            "other",
        ]);
        await changeFolderShare("other", unrelated.id, {
            action: "accept",
            version: 0,
        });
        await inviteToFolder("owner", "source", ["curator"]);
        const notifications: unknown[] = [];
        const listener = await database.sql.listen(
            "riffado_personal",
            (payload) => notifications.push(JSON.parse(payload)),
        );
        try {
            await database.db.transaction(async (tx) => {
                await requestArrivalInTx(tx, {
                    itemId: "later",
                    userId: "owner",
                    folder: {
                        folderId: "elsewhere",
                        ownerId: "owner",
                        scope: "personal",
                    },
                });
                expect(notifications).toEqual([]);
            });
            await vi.waitFor(() =>
                expect(notifications).toEqual([
                    { type: "share", userId: "other" },
                ]),
            );
            await addRecordingToFolder({
                userId: "owner",
                recordingId: "later",
                folderId: "source",
            });
            await database.db
                .select({
                    notify: sql`pg_notify(${"riffado_personal"}, ${'"barrier"'})`,
                })
                .from(users)
                .where(eq(users.id, "owner"));
            await vi.waitFor(() =>
                expect(notifications.at(-1)).toBe("barrier"),
            );
            expect(notifications.slice(0, -1)).toHaveLength(3);
            expect(notifications.slice(1, -1)).toEqual(
                expect.arrayContaining([
                    { type: "share", userId: "receiver" },
                    { type: "share", userId: "other" },
                ]),
            );
            notifications.length = 0;
            await addRecordingToFolder({
                userId: "owner",
                recordingId: "nested",
                folderId: "child",
            });
            await database.db
                .select({
                    notify: sql`pg_notify(${"riffado_personal"}, ${'"barrier"'})`,
                })
                .from(users)
                .where(eq(users.id, "owner"));
            await vi.waitFor(() =>
                expect(notifications.at(-1)).toBe("barrier"),
            );
            expect(notifications).toEqual(["barrier"]);
        } finally {
            await listener.unlisten();
        }
    });
    it.each([
        "subfolder",
        "move",
        "categorize",
    ])("refreshes receivers losing direct access on %s without notifying unrelated folders", async (action) => {
        await accept();
        const [unrelated] = await inviteToFolder("owner", "elsewhere", [
            "other",
        ]);
        await changeFolderShare("other", unrelated.id, {
            action: "accept",
            version: 0,
        });
        const notifications: unknown[] = [];
        const listener = await database.sql.listen(
            "riffado_personal",
            (payload) => notifications.push(JSON.parse(payload)),
        );
        try {
            if (action === "subfolder")
                await addRecordingToFolder({
                    userId: "owner",
                    recordingId: "audio",
                    folderId: "child",
                });
            else if (action === "move")
                await moveRecordingBetweenFolders({
                    userId: "owner",
                    recordingId: "audio",
                    fromFolderId: "source",
                    toFolderId: "child",
                });
            else {
                const response = await categorizePost(
                    request(
                        "recordings/audio/categorize",
                        "POST",
                        { folderIds: ["child"], manualOnly: true },
                        "owner",
                    ),
                    context("audio"),
                );
                expect(response.status).toBe(200);
            }
            await database.db
                .select({
                    notify: sql`pg_notify(${"riffado_personal"}, ${'"barrier"'})`,
                })
                .from(users)
                .where(eq(users.id, "owner"));
            await vi.waitFor(() =>
                expect(notifications.at(-1)).toBe("barrier"),
            );
            expect(notifications).toEqual([
                { type: "share", userId: "receiver" },
                "barrier",
            ]);
            expect(await visibleIds()).toEqual(["mail"]);
        } finally {
            await listener.unlisten();
        }
    });
    it("owner deletion ends shares and removes receiver attachments", async () => {
        await accept();
        await deleteFolder("owner", "source");
        expect(await listMyFolderInvitations("receiver")).toEqual([]);
        expect(await database.db.select().from(folderShares)).toEqual([]);
        expect(
            await database.db.select().from(receivedFolderAttachments),
        ).toEqual([]);
        expect(await visibleIds()).toEqual([]);
        expect(events).toHaveBeenCalledWith("receiver");
    });
    it("moves attachments to the root when the receiver deletes their parent", async () => {
        await accept();
        await deleteFolder("receiver", "my-folder");
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(node.parentId).toBeNull();
        expect(
            (await listFolderOrganization("receiver")).folders.some(
                (folder) => folder.receivedFolder,
            ),
        ).toBe(true);
    });
    it.each([
        false,
        true,
    ])("refuses private-to-Organization folder moves with curator=%s", async (canCurate) => {
        await accept();
        await expect(
            moveFolder({
                userId: "owner",
                folderId: "source",
                parentId: "org-folder",
                canCurate,
            }),
        ).rejects.toMatchObject({ statusCode: canCurate ? 404 : 403 });
        expect(await visibleIds()).toEqual(["audio", "mail"]);
        expect((await listFolderShares("owner", "source"))[0].state).toBe(
            "accepted",
        );
        expect(
            (await listFolderOrganization("owner")).folders.find(
                (folder) => folder.id === "source",
            )?.scope,
        ).toBe("personal");
    });
    it("includes attached folders for categorizing the receiver's own recording", async () => {
        await accept();
        await insertRecording(database.db, {
            id: "receiver-audio",
            userId: "receiver",
            title: "Own recording",
        });
        const panel = await loadPrivateCategorizationPanel(
            "receiver",
            "receiver-audio",
        );
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(panel).not.toBeNull();
        expect(panel?.folders.some((folder) => folder.id === "my-folder")).toBe(
            true,
        );
        expect(panel?.folders.some((folder) => folder.id === node.id)).toBe(
            true,
        );
        expect(panel?.selectedFolderIds).not.toContain(node.id);
    });
    it("marks direct and folder-shared owner items but excludes subfolder items", async () => {
        const share = await accept();
        await inviteToItem("owner", "later", ["receiver"]);
        expect(await listOutgoingSharedItemIds("owner")).toEqual(
            new Set(["audio", "mail", "later"]),
        );
        expect(await listOutgoingSharedItemIds("receiver")).toEqual(new Set());
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "audio",
            folderId: "child",
        });
        expect(await listOutgoingSharedItemIds("owner")).toEqual(
            new Set(["mail", "later"]),
        );
        expect(await isItemReceived("receiver", "audio")).toBe(false);
        await changeFolderShare("owner", share.id, {
            action: "remove",
            version: 1,
        });
        expect(await listOutgoingSharedItemIds("owner")).toEqual(
            new Set(["later"]),
        );
    });
    it("refuses inconsistent assignment ownership in every folder access predicate", async () => {
        await accept();
        await insertRecording(database.db, {
            id: "foreign",
            userId: "other",
            title: "Foreign recording",
        });
        await database.db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId: "foreign", folderId: "source" });
        expect(await isItemReceived("receiver", "foreign")).toBe(false);
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        const where = await folderCondition("receiver", node.id, {
            id: chatterItems.id,
            userId: chatterItems.userId,
        });
        expect(
            await database.db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(and(eq(chatterItems.id, "foreign"), where)),
        ).toEqual([]);
        expect(
            (await listReceivedFolderOrganization("receiver")).assignments.map(
                (row) => row.recordingId,
            ),
        ).not.toContain("foreign");
    });
    it("does not grant unrelated members, curators, or the Organization any person-share visibility", async () => {
        await accept();
        for (const user of ["other", "curator", "organization"]) {
            expect(await visibleIds(user)).toEqual([]);
            expect(await resolveRecordingAccess(user, "audio")).toBeNull();
            expect(
                (await listFolderOrganization(user)).folders.some(
                    (folder) =>
                        folder.receivedFolder || folder.sharedWithPeople,
                ),
            ).toBe(false);
        }
    });
    it("marks the owner's outgoing tree and leaves export trees free of attachments", async () => {
        await accept();
        expect(
            (await listFolderOrganization("owner")).folders.find(
                (folder) => folder.id === "source",
            )?.sharedWithPeople,
        ).toBe(true);
        expect(
            (await listPersonalFolderOrganization("receiver")).folders.some(
                (folder) => folder.receivedFolder,
            ),
        ).toBe(false);
    });
    it("rejects self, Organization, suspended, removed and inactive receivers", async () => {
        await database.db
            .update(users)
            .set({ suspendedAt: new Date() })
            .where(eq(users.id, "other"));
        for (const id of ["owner", "organization", "other", "missing"])
            await expect(
                inviteToFolder("owner", "source", [id]),
            ).rejects.toBeTruthy();
        mockEnv.AUTHZ_MODE = "idp";
        await database.db.insert(userAccessStates).values({
            userId: "receiver",
            issuer: "https://identity.example.com",
            subject: "demo-receiver",
            capabilities: ["use"],
            status: "missing",
            verifiedAt: new Date(),
            source: "verifier",
        });
        await expect(invite()).rejects.toMatchObject({ statusCode: 404 });
    });
    it.each([
        "suspended",
        "disabled",
        "missing",
        "not-granted",
        "unverified",
        "deleted",
    ])("removes %s recipients from folder lookup, invitations, access and restore", async (state) => {
        const accepted = await accept();
        await inviteToFolder("owner", "child", ["receiver"]);
        if (state === "suspended") {
            await database.db
                .update(users)
                .set({ suspendedAt: new Date() })
                .where(eq(users.id, "receiver"));
        } else if (state === "deleted") {
            await database.db.delete(users).where(eq(users.id, "receiver"));
        } else {
            mockEnv.AUTHZ_MODE = "idp";
            if (state !== "unverified") {
                await database.db.insert(userAccessStates).values({
                    userId: "receiver",
                    issuer: "https://identity.example.com",
                    subject: "demo-receiver",
                    status:
                        state === "not-granted"
                            ? "active"
                            : (state as "disabled" | "missing"),
                    capabilities: state === "not-granted" ? [] : ["use"],
                    verifiedAt: new Date(),
                    source: "access-change",
                });
            }
        }
        expect(await findShareRecipients("owner", "Lena")).toEqual([]);
        expect(await listMyFolderInvitations("receiver")).toEqual([]);
        expect(await listReceivedFolderOrganization("receiver")).toEqual({
            folders: [],
            assignments: [],
        });
        expect(await visibleIds()).toEqual([]);
        expect(await resolveRecordingAccess("receiver", "audio")).toBeNull();
        expect(await resolveMailAccess("receiver", "mail")).toBeNull();
        expect(await loadReceivedMailRows("receiver")).toEqual([]);
        await expect(
            changeFolderShare("receiver", accepted.id, {
                action: "rename",
                version: 1,
                name: "Inactive rename",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            inviteToFolder("owner", "elsewhere", ["receiver"]),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            await restoreArchivedFolderShares(
                "owner",
                [
                    {
                        folderId: "old",
                        receiverEmail: "lena@example.com",
                        state: "accepted",
                    },
                ],
                new Map([["old", "elsewhere"]]),
            ),
        ).toMatchObject({
            restored: 0,
            skipped: [{ reason: "receiver_missing" }],
        });
    });
    it("keeps active identity-provider folder recipients invitable and readable", async () => {
        mockEnv.AUTHZ_MODE = "idp";
        await database.db.insert(userAccessStates).values({
            userId: "receiver",
            issuer: "https://identity.example.com",
            subject: "demo-receiver",
            capabilities: ["use"],
            verifiedAt: new Date(),
            source: "login",
        });
        const pending = await invite();
        expect(await listMyFolderInvitations("receiver")).toHaveLength(1);
        await changeFolderShare("receiver", pending.id, {
            action: "accept",
            version: 0,
        });
        expect(await visibleIds()).toEqual(["audio", "mail"]);
        expect(
            (await listReceivedFolderOrganization("receiver")).assignments,
        ).toHaveLength(2);
        expect(
            await restoreArchivedFolderShares(
                "owner",
                [
                    {
                        folderId: "old",
                        receiverEmail: "lena@example.com",
                        state: "accepted",
                    },
                ],
                new Map([["old", "elsewhere"]]),
            ),
        ).toEqual({ restored: 1, skipped: [] });
    });
    it.each([
        ["receiver", "audio"],
        ["curator", "audio"],
        ["receiver", "mail"],
        ["curator", "mail"],
    ])("keeps %s Organization content and task rights for folder item %s", async (userId, itemId) => {
        const curates = userId === "curator";
        const owner = await taskViewer(
            { id: "owner", email: "alex@example.com" },
            localActor("owner"),
        );
        const task = await addTask(owner, itemId, {
            text: "Check the route",
            status: "open",
        });
        const [share] = await inviteToFolder("owner", "source", [userId]);
        const publish = () =>
            database.db.insert(recordingFolderAssignments).values({
                userId: "owner",
                itemId,
                folderId: "org-folder",
            });
        await publish();
        const before = await requireRecordingView(userId, itemId, "org", {
            kinds: ["audio", "mail"],
        });
        expect(before).toMatchObject({
            role: "member",
            shared: true,
            received: false,
        });
        await changeFolderShare(userId, share.id, {
            action: "accept",
            version: 0,
            name: "My folder",
        });
        const access = await requireRecordingView(userId, itemId, "org", {
            kinds: ["audio", "mail"],
        });
        expect(access).toMatchObject({
            role: before.role,
            shared: true,
            received: true,
        });
        if (curates)
            expect(() =>
                assertMayChange(access, userId, curates),
            ).not.toThrow();
        else expect(() => assertMayChange(access, userId, curates)).toThrow();
        const received = await requireRecordingView(
            userId,
            itemId,
            "received",
            { kinds: ["audio", "mail"] },
        );
        expect(() => assertMayChange(received, userId, curates)).toThrow(
            "Received items are read-only",
        );
        if (itemId === "mail")
            expect(await resolveMailAccess(userId, itemId)).toMatchObject({
                role: "member",
            });
        const viewer = await taskViewer(
            {
                id: userId,
                email: curates ? "sam@example.com" : "lena@example.com",
            },
            localActor(userId),
        );
        const listed = await listRecordingTasks(viewer, itemId);
        expect(listed?.tasks.find((row) => row.id === task.id)).toMatchObject({
            canEdit: curates,
            canClose: curates,
        });
        if (curates) {
            const edited = await updateTask(viewer, task.id, {
                version: task.version,
                text: "Updated by curator",
            });
            await updateTask(viewer, task.id, {
                version: edited.version,
                status: "done",
            });
        } else {
            await expect(
                updateTask(viewer, task.id, {
                    version: task.version,
                    text: "Forbidden edit",
                }),
            ).rejects.toMatchObject({ statusCode: 403 });
        }
        await database.db
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, itemId),
                    eq(recordingFolderAssignments.folderId, "org-folder"),
                ),
            );
        const withdrawn = await requireRecordingView(
            userId,
            itemId,
            "received",
            { kinds: ["audio", "mail"] },
        );
        expect(withdrawn).toMatchObject({
            role: "receiver",
            shared: false,
            received: true,
        });
        expect(() => assertMayChange(withdrawn, userId, curates)).toThrow(
            "Received items are read-only",
        );
        expect((await listFolderShares("owner", "source"))[0].state).toBe(
            "accepted",
        );
        expect(
            (await listRecordingTasks(viewer, itemId))?.tasks.find(
                (row) => row.id === task.id,
            ),
        ).toMatchObject({ canEdit: false, canClose: false });
        if (itemId === "mail")
            expect(await resolveMailAccess(userId, itemId)).toMatchObject({
                role: "receiver",
            });
    });
    it("keeps folder speaker reads plain and correction meanings outside private Almanac names", async () => {
        await accept();
        const transcriptionId = await insertTranscript(
            database.db,
            "audio",
            "owner",
            { text: "Project body" },
        );
        await database.db.insert(people).values({
            id: "private-speaker",
            userId: "owner",
            displayName: encryptText("Priya Raman"),
            notes: encryptText("Private speaker notes"),
        });
        await attributeSpeaker(database.db, {
            userId: "owner",
            transcriptionId,
            label: "speaker_0",
            personId: "private-speaker",
        });
        await database.db.insert(knowledgeEntities).values({
            id: "private-project",
            userId: "owner",
            typeKey: "project",
            name: encryptText("Confidential acquisition"),
            nameHmac: "private-project",
            description: encryptText("Private project notes"),
        });
        await database.db.insert(transcriptCorrections).values([
            {
                id: "linked",
                userId: "owner",
                transcriptionId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 0,
                charEnd: 7,
                heard: encryptText("Project"),
                heardHmac: "project",
                kind: "link",
                targetEntityId: "private-project",
            },
            {
                id: "corrected",
                userId: "owner",
                transcriptionId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 8,
                charEnd: 12,
                heard: encryptText("body"),
                heardHmac: "body",
                kind: "correct",
                targetEntityId: "private-project",
                replacement: encryptText("plan"),
            },
        ]);
        const knowledge = vi.spyOn(knowledgeLoader, "knowledgeView");
        try {
            const corrections = await readCorrections(
                request("recordings/audio/corrections?view=received", "GET"),
                context("audio"),
            );
            expect(corrections.status).toBe(200);
            const payload = await corrections.json();
            expect(payload).toMatchObject({
                canUndo: false,
                corrections: [
                    { id: "linked", meaning: "Project", replacement: null },
                    { id: "corrected", meaning: "plan", replacement: "plan" },
                ],
            });
            expect(JSON.stringify(payload)).not.toMatch(
                /Confidential acquisition|private-project|Private project notes/,
            );
            expect(knowledge).not.toHaveBeenCalled();
            for (const shared of [false, true]) {
                if (shared)
                    await database.db
                        .insert(recordingFolderAssignments)
                        .values({
                            userId: "owner",
                            itemId: "audio",
                            folderId: "org-folder",
                        });
                const response = await readSpeakers(
                    request("recordings/audio/speakers?view=received", "GET"),
                    context("audio"),
                );
                expect(response.status).toBe(200);
                const speakers = await response.json();
                expect(speakers.speakers).toMatchObject([
                    {
                        personName: "Priya Raman",
                        personId: null,
                        confirmedByUserId: null,
                    },
                ]);
                expect(JSON.stringify(speakers)).not.toMatch(
                    /private-speaker|Private speaker notes/,
                );
            }
        } finally {
            knowledge.mockRestore();
        }
    });
    it("masks secret mail subjects in the combined invitation list and inherited mail rows", async () => {
        const localPart = "alex.private-token";
        await database.db.insert(mailAddresses).values({
            id: "base-mailbox",
            localPartHash: localPartHash("alex"),
            localPart: encryptText("alex"),
            kind: "mailbox",
            namespaceUserId: "owner",
        });
        await database.db.insert(mailAddresses).values({
            localPartHash: localPartHash(localPart),
            localPart: encryptText(localPart),
            kind: "secret",
            namespaceUserId: "owner",
            baseAddressId: "base-mailbox",
        });
        const title = `Mail for ${localPart}@mail.example.com`;
        await database.db
            .update(chatterItems)
            .set({ title: encryptText(title) })
            .where(eq(chatterItems.id, "mail"));
        await database.db
            .update(recordingFolders)
            .set({ name: encryptText(title) })
            .where(eq(recordingFolders.id, "source"));
        const share = await invite();
        await inviteToItem("owner", "mail", ["receiver"]);
        const pending = await invitationsRoute(request("shares", "GET"));
        expect(pending.status).toBe(200);
        const invitations = (await pending.json()).invitations as {
            kind: string;
            title: string;
        }[];
        expect(invitations.map((row) => row.kind).sort()).toEqual([
            "folder",
            "mail",
        ]);
        for (const invitation of invitations) {
            expect(invitation.title).not.toContain("private-token");
            expect(invitation.title).toContain(
                "alex.•••••••••••••@mail.example.com",
            );
        }
        await changeFolderShare("receiver", share.id, {
            action: "accept",
            version: 0,
        });
        const rows = await loadReceivedMailRows("receiver");
        expect(rows).toHaveLength(1);
        expect(rows[0].filename).not.toContain("private-token");
        expect(rows[0].filename).toContain(
            "alex.•••••••••••••@mail.example.com",
        );
        const masked = "Mail for alex.•••••••••••••@mail.example.com";
        const attached = (
            await listFolderOrganization("receiver")
        ).folders.find((folder) => folder.receivedFolder);
        expect(attached).toMatchObject({
            name: masked,
            receivedFolder: { originalName: masked },
        });
        const [stored] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(decryptText(stored.name)).toBe(masked);
    });
    it.each([
        "audio",
        "mail",
    ])("restores a folder containing Organization-visible %s just like a fresh invitation", async (itemId) => {
        await database.db
            .insert(recordingFolderAssignments)
            .values({ userId: "owner", itemId, folderId: "org-folder" });
        expect(
            await restoreArchivedFolderShares(
                "owner",
                [
                    {
                        folderId: "old",
                        receiverEmail: "lena@example.com",
                        state: "accepted",
                    },
                ],
                new Map([["old", "source"]]),
            ),
        ).toEqual({ restored: 1, skipped: [] });
        expect((await listFolderShares("owner", "source"))[0].state).toBe(
            "pending",
        );
        expect(
            await database.db.select().from(receivedFolderAttachments),
        ).toEqual([]);
        await database.db.delete(folderShares);
        expect(
            (await inviteToFolder("owner", "source", ["receiver"]))[0].state,
        ).toBe("pending");
    });
    it("skips restoring an Organization-visible folder", async () => {
        await database.db
            .update(recordingFolders)
            .set({ kind: "public" })
            .where(eq(recordingFolders.id, "source"));
        expect(
            await restoreArchivedFolderShares(
                "owner",
                [
                    {
                        folderId: "old",
                        receiverEmail: "lena@example.com",
                        state: "pending",
                    },
                ],
                new Map([["old", "source"]]),
            ),
        ).toMatchObject({
            restored: 0,
            skipped: [{ reason: "organization_shared" }],
        });
        expect(await database.db.select().from(folderShares)).toEqual([]);
    });
    it("uses Organization MCP views for published folder items and received views after withdrawal", async () => {
        await accept();
        await database.db.insert(accounts).values({
            userId: "receiver",
            providerId: "oidc",
            accountId: "receiver-sub",
        });
        const caller = async () => {
            const result = await resolveCaller({
                sub: "receiver-sub",
                azp: "demo-client",
                resource_access: {
                    "chatterbox-mcp": {
                        roles: ["transcripts:read", "mail:read"],
                    },
                },
            });
            if (!result.ok) throw new Error(result.reason);
            return result.caller;
        };
        const privateCaller = await caller();
        expect(privateCaller.receivedItemIds).toEqual(
            new Set(["audio", "mail"]),
        );
        expect(recordingViewFor(privateCaller, "owner", "audio")).toBe(
            "received",
        );
        await database.db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "audio",
            folderId: "org-folder",
        });
        const sharedCaller = await caller();
        expect(sharedCaller.receivedItemIds).toEqual(new Set(["mail"]));
        expect(recordingViewFor(sharedCaller, "owner", "audio")).toBe("org");
        expect(
            (await listReceivedFolderOrganization("receiver")).assignments,
        ).toHaveLength(2);
        await database.db
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, "audio"),
                    eq(recordingFolderAssignments.folderId, "org-folder"),
                ),
            );
        expect(recordingViewFor(await caller(), "owner", "audio")).toBe(
            "received",
        );
    });
    it("rejects receivers on every owner folder write route", async () => {
        await accept();
        const responses = [
            await renameRoute(
                request("folders/source", "PATCH", { name: "Forged" }),
                context(),
            ),
            await renameRoute(
                request("folders/source", "PATCH", { parentId: "my-folder" }),
                context(),
            ),
            await deleteRoute(request("folders/source", "DELETE"), context()),
            await createRoute(
                request("folders", "POST", {
                    parentId: "source",
                    name: "Forged",
                }),
            ),
            await settingsRoute(
                request("folders/source/default-profiles", "PUT", {
                    channel: "audio",
                    profileId: null,
                    manualOnly: false,
                }),
                context(),
            ),
            await assignRoute(
                request("recordings/audio/folders", "POST", {
                    folderId: "source",
                }),
                context("audio"),
            ),
            await inviteRoute(
                request("folders/source/shares", "POST", {
                    receiverIds: ["other"],
                }),
                context(),
            ),
            await listRoute(request("folders/source/shares", "GET"), context()),
        ];
        expect(responses.map((response) => response.status)).toEqual([
            404, 404, 404, 404, 404, 403, 404, 404,
        ]);
    });
    it.each([
        "source",
        "attachment",
    ])("refuses receiver exports, synchronization and mail addresses for %s", async (target) => {
        await accept();
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        const id = target === "source" ? "source" : node.id;
        const ctx = context(id);
        const responses = [
            await exportsGet(request(`folders/${id}/exports`, "GET"), ctx),
            await exportsPost(
                request(`folders/${id}/exports`, "POST", {
                    provider: "filesystem",
                    targetPath: "folder-share-test",
                    exportAudio: true,
                    exportTranscript: true,
                    exportSummary: true,
                }),
                ctx,
            ),
            await synchronizePost(
                request(`folders/${id}/synchronize`, "POST"),
                ctx,
            ),
            await addressesGet(
                request(`folders/${id}/mail-addresses`, "GET"),
                ctx,
            ),
            await addressesGet(
                request(`folders/${id}/mail-addresses?subtree=1`, "GET"),
                ctx,
            ),
            await addressesPut(
                request(`folders/${id}/mail-addresses`, "PUT", {
                    alias: "forged",
                }),
                ctx,
            ),
        ];
        expect(responses.map((response) => response.status)).toEqual([
            404, 404, 404, 404, 404, 404,
        ]);
        expect(await database.db.select().from(asyncJobs)).toEqual([]);
    });
    it("keeps export synchronization available to the folder owner", async () => {
        const response = await synchronizePost(
            request("folders/source/synchronize", "POST", undefined, "owner"),
            context(),
        );
        expect(response.status).toBe(202);
        expect(
            await database.db
                .select({ userId: asyncJobs.userId })
                .from(asyncJobs),
        ).toEqual([{ userId: "owner" }]);
    });
    it("refuses normal folder routes for attachment IDs", async () => {
        await accept();
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        expect(
            (
                await renameRoute(
                    request(`folders/${node.id}`, "PATCH", { name: "Forged" }),
                    context(node.id),
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await createRoute(
                    request("folders", "POST", {
                        parentId: node.id,
                        name: "Forged",
                    }),
                )
            ).status,
        ).toBe(404);
        expect(
            (
                await assignRoute(
                    request("recordings/audio/folders", "POST", {
                        folderId: node.id,
                    }),
                    context("audio"),
                )
            ).status,
        ).toBe(403);
    });
    it.each([
        "hosted",
        "local",
    ])("gates every folder sharing route on %s deployments", async (mode) => {
        if (mode === "hosted") mockEnv.IS_HOSTED = true;
        else mockEnv.SELF_HOST_MODE = "local";
        const results = [
            await inviteRoute(
                request(
                    "folders/source/shares",
                    "POST",
                    { receiverIds: ["receiver"] },
                    "owner",
                ),
                context(),
            ),
            await listRoute(
                request("folders/source/shares", "GET", undefined, "owner"),
                context(),
            ),
            await folderAction(
                request("folder-shares/demo", "PATCH", {
                    action: "accept",
                    version: 0,
                }),
                context("demo"),
            ),
            await restoreRoute(
                request("folder-shares/restore", "POST", {
                    shares: [],
                    folderIds: {},
                }),
            ),
        ];
        expect(results.map((response) => response.status)).toEqual([
            404, 404, 404, 404,
        ]);
    });
    it("lists and filters attached folders in MCP and excludes them from a service caller", async () => {
        await accept();
        const caller = userCaller(
            "receiver",
            "lena@example.com",
            ["transcripts:read", "mail:read"],
            "organization",
        );
        const tool = ALL_TOOLS.find((tool) => tool.name === "list_folders");
        if (!tool) throw new Error("Missing folder tool");
        const result = await tool.run({ caller, touched: [] }, {});
        const serialized = JSON.stringify(result);
        expect(serialized).toContain("My research");
        expect(serialized).toContain('"read_only":true');
        expect(serialized).not.toContain("Unrelated private context");
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        const where = await folderCondition("receiver", node.id, {
            id: chatterItems.id,
            userId: chatterItems.userId,
        });
        expect(
            (
                await database.db
                    .select({ id: chatterItems.id })
                    .from(chatterItems)
                    .where(where)
            )
                .map((row) => row.id)
                .sort(),
        ).toEqual(["audio", "mail"]);
        const service = serviceCaller("organization", [
            "transcripts:read",
            "mail:read",
        ]);
        expect(
            await database.db
                .select()
                .from(chatterItems)
                .where(mcpItemCondition(service, ["audio", "mail"])),
        ).toEqual([]);
        const folders = await tool.run({ caller: service, touched: [] }, {});
        expect(JSON.stringify(folders)).not.toContain("My research");
    });
    it("keeps search and mail lists distinct when direct and folder shares overlap", async () => {
        await accept();
        for (const itemId of ["audio", "mail"]) {
            const [share] = await inviteToItem("owner", itemId, ["receiver"]);
            await changePersonShare("receiver", share.id, {
                action: "accept",
                version: 0,
                folderId: "my-folder",
            });
        }
        const result = await searchApp(
            await taskViewer({ id: "receiver", email: "lena@example.com" }),
            "chatter",
            "Project",
        );
        expect(result.chatter.map((hit) => hit.id).sort()).toEqual([
            "audio",
            "mail",
        ]);
        expect(
            (await loadReceivedMailRows("receiver")).map((row) => row.id),
        ).toEqual(["mail"]);
        const items = await searchItems({
            viewerUserId: "receiver",
            query: "Project",
            view: "private",
        });
        expect(items.hits.map((hit) => hit.id).sort()).toEqual([
            "audio",
            "mail",
        ]);
    });
    it("exports only the owner's folder invitations and restores active ones as pending", async () => {
        await accept();
        const own = await collectArchivedFolderShares({
            kind: "personal",
            userId: "owner",
        });
        expect(own).toHaveLength(1);
        expect(own[0]).toMatchObject({
            folderId: "source",
            receiverEmail: "lena@example.com",
            state: "accepted",
        });
        expect(JSON.stringify(own)).not.toContain("My research");
        expect(
            await collectArchivedFolderShares({
                kind: "personal",
                userId: "receiver",
            }),
        ).toEqual([]);
        expect(
            await database.db
                .select()
                .from(chatterItems)
                .where(
                    archivedItemCondition({
                        kind: "personal",
                        userId: "receiver",
                    }),
                ),
        ).toEqual([]);
        await database.db.delete(folderShares);
        const result = await restoreArchivedFolderShares(
            "owner",
            [
                ...own,
                {
                    folderId: "source",
                    receiverEmail: "absent@example.com",
                    state: "accepted",
                },
                {
                    folderId: "source",
                    receiverEmail: "priya@example.com",
                    state: "removed",
                },
            ],
            new Map([["source", "source"]]),
        );
        expect(result.restored).toBe(1);
        expect(result.skipped.map((row) => row.reason)).toEqual([
            "receiver_missing",
            "inactive",
        ]);
        expect((await listFolderShares("owner", "source"))[0].state).toBe(
            "pending",
        );
        expect(
            await database.db.select().from(receivedFolderAttachments),
        ).toEqual([]);
        expect(await visibleIds()).toEqual([]);
    });
    it("refuses restore mappings to another owner's folder", async () => {
        const result = await restoreArchivedFolderShares(
            "receiver",
            [
                {
                    folderId: "old",
                    receiverEmail: "alex@example.com",
                    state: "accepted",
                },
            ],
            new Map([["old", "source"]]),
        );
        expect(result).toMatchObject({
            restored: 0,
            skipped: [{ reason: "folder_missing" }],
        });
    });
    it("keeps assigned task rights and counts live folder acceptance", async () => {
        await database.db.insert(people).values({
            id: "assignee",
            userId: "owner",
            displayName: encryptText("Lena Fischer"),
            primaryEmail: encryptText("lena@example.com"),
            primaryEmailHash: lookupHash("lena@example.com"),
        });
        const ownerViewer = await taskViewer(
            { id: "owner", email: "alex@example.com" },
            localActor("owner"),
        );
        const receiverViewer = await taskViewer(
            { id: "receiver", email: "lena@example.com" },
            localActor("receiver"),
        );
        const task = await addTask(ownerViewer, "audio", {
            text: "Send plan",
            assigneePersonId: "assignee",
            status: "open",
        });
        await markTasksSeen(receiverViewer);
        await accept();
        expect(await countNewTasks(receiverViewer)).toBe(1);
        const tasks = await listTasks(receiverViewer, {
            tab: "mine",
            state: "all",
            folderId: null,
            due: null,
            today: "2026-10-22",
            sort: "created",
        });
        expect(tasks.some((row) => row.id === task.id)).toBe(true);
        await updateTask(receiverViewer, task.id, {
            version: task.version,
            status: "done",
        });
        await expect(
            updateTask(receiverViewer, task.id, {
                version: task.version + 1,
                text: "Forged",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await removeRecordingFromFolder({
            userId: "owner",
            recordingId: "audio",
            folderId: "source",
        });
        expect(
            (
                await listTasks(receiverViewer, {
                    tab: "mine",
                    state: "all",
                    folderId: null,
                    due: null,
                    today: "2026-10-22",
                    sort: "created",
                })
            ).some((row) => row.id === task.id),
        ).toBe(false);
    });
    it("keeps the owner's own tasks filed in a shared folder away from receivers", async () => {
        const ownerViewer = await taskViewer(
            { id: "owner", email: "alex@example.com" },
            localActor("owner"),
        );
        const receiverViewer = await taskViewer(
            { id: "receiver", email: "lena@example.com" },
            localActor("receiver"),
        );
        const own = await createPersonalTask(ownerViewer, {
            text: "Private follow-up",
            folderId: "source",
        });
        await accept();
        const [node] = await database.db
            .select()
            .from(receivedFolderAttachments);
        const query = {
            state: "all",
            due: null,
            today: "2026-10-22",
            sort: "created",
        } as const;
        for (const tab of ["mine", "followed", "tracked"] as const)
            for (const folderId of [null, node.id]) {
                const rows = await listTasks(receiverViewer, {
                    ...query,
                    tab,
                    folderId,
                });
                expect(rows.some((row) => row.id === own.id)).toBe(false);
            }
        await expect(
            followTask(receiverViewer, own.id, true),
        ).rejects.toMatchObject({ statusCode: 404 });
        const tool = ALL_TOOLS.find((tool) => tool.name === "list_tasks");
        if (!tool) throw new Error("Missing task tool");
        const caller = userCaller(
            "receiver",
            "lena@example.com",
            ["tasks:read"],
            "organization",
        );
        const listed = await tool.run(
            { caller, touched: [] },
            z.object(tool.input(caller)).parse({ status: "all" }),
        );
        expect(JSON.stringify(listed)).not.toContain(own.id);
        expect(
            (
                await listTasks(ownerViewer, {
                    ...query,
                    tab: "mine",
                    folderId: "source",
                })
            ).some((row) => row.id === own.id),
        ).toBe(true);
    });
    const contribute = async (
        kind: "audio" | "mail" = "audio",
        userId = "receiver",
    ) => {
        const id = `${userId}-${kind}`;
        if (kind === "audio")
            await insertRecording(database.db, {
                id,
                userId,
                title: "Acme contribution",
            });
        else {
            await database.db.insert(chatterItems).values({
                id,
                userId,
                kind,
                title: encryptText("Acme contribution"),
                occurredAt: new Date(),
            });
            await database.db.insert(mailMessages).values({
                id,
                userId,
                rawHash: id,
                receivedAt: new Date(),
                sizeBytes: 10,
                auth: encryptJsonField({ dkim: [], spf: null, arc: null }),
                senderVerified: true,
            });
        }
        await addRecordingToFolder({
            userId,
            recordingId: id,
            folderId: "source",
        });
        return id;
    };
    const acceptOther = async () => {
        const shares = await inviteToFolder("owner", "source", ["other"]);
        const share = shares.find((row) => row.receiverUserId === "other");
        if (!share) throw new Error("Missing invitation");
        await changeFolderShare("other", share.id, {
            action: "accept",
            version: share.version,
        });
    };
    it.each([
        "audio",
        "mail",
    ] as const)("shares participant-owned %s with the folder owner and fellow participants once", async (kind) => {
        await accept();
        await acceptOther();
        const id = await contribute(kind);
        expect(await isItemReceived("receiver", id)).toBe(false);
        for (const viewer of ["owner", "other"]) {
            expect(
                (await visibleIds(viewer)).filter((value) => value === id),
            ).toHaveLength(1);
            expect(
                await resolveRecordingAccess(viewer, id, {
                    kinds: ["audio", "mail"],
                }),
            ).toMatchObject({ role: "receiver", ownerUserId: "receiver" });
            const result = await searchItems({
                viewerUserId: viewer,
                query: "Acme",
                view: "private",
            });
            expect(result.hits.filter((hit) => hit.id === id)).toHaveLength(1);
            const caller = userCaller(
                viewer,
                `${viewer}@example.com`,
                ["transcripts:read", "mail:read"],
                "organization",
            );
            expect(
                await database.db
                    .select({ id: chatterItems.id })
                    .from(chatterItems)
                    .where(
                        and(
                            eq(chatterItems.id, id),
                            mcpItemCondition(caller, ["audio", "mail"]),
                        ),
                    ),
            ).toHaveLength(1);
        }
        expect(
            await resolveRecordingAccess("receiver", id, {
                kinds: ["audio", "mail"],
            }),
        ).toMatchObject({ role: "owner" });
        expect(await isItemReceived("curator", id)).toBe(false);
        const tree = await listFolderOrganization("owner");
        expect(
            tree.assignments.filter((row) => row.recordingId === id),
        ).toEqual([{ recordingId: id, folderId: "source" }]);
        const [node] = (await listReceivedFolderOrganization("receiver"))
            .folders;
        const condition = await folderCondition("receiver", node.id, {
            id: chatterItems.id,
            userId: chatterItems.userId,
        });
        expect(
            await database.db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(and(eq(chatterItems.id, id), condition)),
        ).toHaveLength(1);
        expect(await listOutgoingSharedItemIds("receiver")).toContain(id);
        const [assignment] = await database.db
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, id));
        expect(assignment).toMatchObject({
            userId: "receiver",
            folderId: "source",
        });
    });
    it.each([
        "pending",
        "declined",
        "removed",
    ] as const)("refuses filing by a %s receiver", async (state) => {
        const share = await invite();
        if (state === "declined")
            await changeFolderShare("receiver", share.id, {
                action: "decline",
                version: 0,
            });
        if (state === "removed") {
            await changeFolderShare("receiver", share.id, {
                action: "accept",
                version: 0,
            });
            await changeFolderShare("receiver", share.id, {
                action: "remove",
                version: 1,
            });
        }
        await insertRecording(database.db, { id: "own", userId: "receiver" });
        await expect(
            addRecordingToFolder({
                userId: "receiver",
                recordingId: "own",
                folderId: "source",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            prepareMeeting("receiver", {
                folderId: "source",
                title: "Acme agenda",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("resolves attachment names and source IDs as filing targets without exposing subfolders", async () => {
        await accept();
        const [node] = (await listReceivedFolderOrganization("receiver"))
            .folders;
        expect(
            await assertCategorizableFolders("receiver", [node.id, "source"]),
        ).toEqual([
            { folderId: "source", ownerId: "owner", scope: "personal" },
        ]);
        expect(
            await assertCategorizableFolder("receiver", node.id),
        ).toMatchObject({
            folderId: "source",
            ownerId: "owner",
            scope: "personal",
        });
        expect(
            (await listRecordingFolderTrees("receiver")).find(
                (row) => row.id === node.id,
            )?.name,
        ).toBe("My research");
        await expect(
            assertCategorizableFolder("receiver", "child"),
        ).rejects.toMatchObject({ statusCode: 404 });
        const response = await recorderFolders(
            new Request("http://localhost/api/v1/recorder/folders?q=research"),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual([
            {
                id: "source",
                name: "My research",
                path: "Private / Projects / My research",
                scope: "personal",
                sharedWithPeople: true,
            },
        ]);
        const lookup = await recorderFolders(
            new Request("http://localhost/api/v1/recorder/folders?id=source"),
        );
        expect((await lookup.json()).data[0].name).toBe("My research");
    });
    it.each([
        "owner",
        "receiver",
    ])("lets %s unfile a contribution while preserving its owner and content", async (actor) => {
        await accept();
        await acceptOther();
        const id = await contribute();
        const response = await unfileRoute(
            request(
                `recordings/${id}/folders`,
                "DELETE",
                { folderId: "source" },
                actor,
            ),
            context(id),
        );
        expect(response.status).toBe(200);
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, id)),
        ).toEqual([]);
        expect(await resolveRecordingAccess("owner", id)).toBeNull();
        expect(await resolveRecordingAccess("receiver", id)).toMatchObject({
            role: "owner",
        });
    });
    it("refuses unfiling or moving a fellow participant's item and further folder invitations", async () => {
        await accept();
        await acceptOther();
        const id = await contribute();
        await removeRecordingFromFolder({
            userId: "other",
            recordingId: id,
            folderId: "source",
        });
        expect(await isItemReceived("owner", id)).toBe(true);
        await expect(
            moveRecordingBetweenFolders({
                userId: "other",
                recordingId: id,
                fromFolderId: "source",
                toFolderId: "my-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            inviteToFolder("receiver", "source", ["other"]),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(() =>
            assertMayChange(
                {
                    view: "received",
                    ownerUserId: "receiver",
                    role: "receiver",
                    shared: false,
                    orgUserId: "organization",
                },
                "owner",
                false,
            ),
        ).toThrow();
    });
    it.each([
        "owner",
        "receiver",
        "delete",
    ])("unfiles a leaving participant's items on %s removal and preserves independent access", async (actor) => {
        const share = await accept();
        await acceptOther();
        const id = await contribute();
        const meeting = await prepareMeeting("receiver", {
            folderId: "source",
            title: "Acme agenda",
        });
        const [direct] = await inviteToItem("receiver", id, ["owner"]);
        await changePersonShare("owner", direct.id, {
            action: "accept",
            version: direct.version,
            folderId: "elsewhere",
        });
        if (actor === "delete") await deleteFolder("owner", "source");
        else
            await changeFolderShare(actor, share.id, {
                action: "remove",
                version: 1,
            });
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.userId, "receiver")),
        ).toEqual([]);
        expect(await isItemReceived("other", id)).toBe(false);
        expect(await isItemReceived("owner", id)).toBe(true);
        expect(await resolveRecordingAccess("receiver", id)).toMatchObject({
            role: "owner",
        });
        expect((await getMeeting("receiver", meeting.id)).unchanged).toBe(
            false,
        );
        await expect(getMeeting("owner", meeting.id)).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(events).toHaveBeenCalledWith("receiver");
    });
    it("uses each contributor's unfiled profile and excludes contributions from other owners' exports and archives", async () => {
        await accept();
        const id = await contribute();
        const ownProfile = await createProfile({
            ownerUserId: "receiver",
            actor: localActor("receiver"),
            scope: "personal",
            channel: "audio",
            name: "Own audio",
            settings: defaultProfileSettings("audio"),
        });
        await setDefaultProfile({
            ownerUserId: "receiver",
            actor: localActor("receiver"),
            channel: "audio",
            profileId: ownProfile.id,
        });
        await database.db
            .insert(folderDefaultProfiles)
            .values({ folderId: "source", channel: "audio", manualOnly: true });
        const input = {
            ownerUserId: "receiver",
            itemId: id,
            channel: "audio" as const,
            view: "private" as const,
        };
        expect(
            await resolveProfileForPlacements({
                ...input,
                folderIds: ["source"],
            }),
        ).toEqual(
            await resolveProfileForPlacements({ ...input, folderIds: [] }),
        );
        expect(
            await resolveArrivalProfile({ ...input, folderIds: ["source"] }),
        ).toMatchObject({
            profile: { ownerUserId: "receiver" },
            manualOnly: false,
        });
        expect(
            await resolveArrivalProfile({
                ownerUserId: "owner",
                itemId: "audio",
                channel: "audio",
                folderIds: ["source"],
            }),
        ).toMatchObject({ manualOnly: true });
        expect(
            (await listExportFolderOrganization("owner")).assignments.some(
                (row) => row.recordingId === id,
            ),
        ).toBe(false);
        expect(
            (await listPersonalFolderOrganization("receiver")).folders.some(
                (row) => row.receivedFolder,
            ),
        ).toBe(false);
        for (const viewer of ["owner", "other"])
            expect(
                await database.db
                    .select({ id: chatterItems.id })
                    .from(chatterItems)
                    .where(
                        and(
                            eq(chatterItems.id, id),
                            archivedItemCondition({
                                kind: "personal",
                                userId: viewer,
                            }),
                        ),
                    ),
            ).toEqual([]);
        expect(
            await database.db
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, id),
                        archivedItemCondition({
                            kind: "personal",
                            userId: "receiver",
                        }),
                    ),
                ),
        ).toHaveLength(1);
    });
    it("lets every participant co-edit a receiver-authored agenda, keeps manage with its author, and accepts another participant's own recording", async () => {
        await accept();
        await acceptOther();
        const meeting = await prepareMeeting("receiver", {
            folderId: "source",
            title: "Acme agenda",
        });
        const [node] = (await listReceivedFolderOrganization("receiver"))
            .folders;
        const listed = await listMeetings("receiver", {
            folderId: node.id,
            includePast: true,
        });
        expect(listed.map((row) => row.id)).toContain(meeting.id);
        expect(
            listed.find((row) => row.id === meeting.id)?.folders[0],
        ).toMatchObject({ id: node.id, name: "My research" });
        for (const actor of ["owner", "other"]) {
            const detail = await getMeeting(actor, meeting.id);
            if (detail.unchanged) throw new Error("Missing detail");
            expect(detail.permissions).toMatchObject({
                edit: true,
                manage: false,
            });
            await addPoint(actor, meeting.id, { text: "Acme discussion" });
            await expect(
                patchMeeting(actor, meeting.id, { title: "Forged" }),
            ).rejects.toMatchObject({ statusCode: 403 });
            expect(
                (
                    await collectArchivedMeetings({
                        kind: "personal",
                        userId: actor,
                    })
                ).some((row) => row.id === meeting.id),
            ).toBe(false);
        }
        expect(
            (
                await collectArchivedMeetings({
                    kind: "personal",
                    userId: "receiver",
                })
            ).map((row) => row.id),
        ).toContain(meeting.id);
        await insertRecording(database.db, {
            id: "other-audio",
            userId: "other",
        });
        await attachAgenda("other", meeting.id, "other-audio");
        for (const actor of ["owner", "receiver"])
            expect(await isItemReceived(actor, "other-audio")).toBe(true);
        expect(await isItemReceived("other", "other-audio")).toBe(false);
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "other-audio")),
        ).toEqual([
            expect.objectContaining({ userId: "other", folderId: "source" }),
        ]);
    });
    it("notifies the folder owner and other accepted participants, excluding the contributor and pending invitations", async () => {
        await accept();
        await acceptOther();
        await inviteToFolder("owner", "source", ["curator"]);
        await insertRecording(database.db, {
            id: "arriving",
            userId: "receiver",
        });
        const notifications: unknown[] = [];
        const listener = await database.sql.listen(
            "riffado_personal",
            (payload) => notifications.push(JSON.parse(payload)),
        );
        try {
            await database.db.transaction(async (tx) => {
                await requestArrivalInTx(tx, {
                    userId: "receiver",
                    itemId: "arriving",
                    folder: {
                        folderId: "source",
                        ownerId: "owner",
                        scope: "personal",
                    },
                });
                expect(notifications).toEqual([]);
            });
            await vi.waitFor(() => expect(notifications).toHaveLength(2));
            expect(notifications).toEqual(
                expect.arrayContaining([
                    { type: "share", userId: "owner" },
                    { type: "share", userId: "other" },
                ]),
            );
            expect(
                await database.db
                    .select({ userId: itemProcessing.userId })
                    .from(itemProcessing)
                    .where(eq(itemProcessing.itemId, "arriving")),
            ).toEqual([{ userId: "receiver" }]);
        } finally {
            await listener.unlisten();
        }
    });
    it.each([
        "filing-first",
        "removal-first",
    ])("serializes participation checks with revocation (%s)", async (order) => {
        const share = await accept();
        await insertRecording(database.db, {
            id: "racing",
            userId: "receiver",
        });
        const operations = {
            filing: () =>
                addRecordingToFolder({
                    userId: "receiver",
                    recordingId: "racing",
                    folderId: "source",
                }),
            removal: () =>
                changeFolderShare("owner", share.id, {
                    action: "remove",
                    version: 1,
                }),
        };
        const results = await Promise.allSettled(
            order === "filing-first"
                ? [operations.filing(), operations.removal()]
                : [operations.removal(), operations.filing()],
        );
        expect(results[1 - Number(order === "removal-first")].status).toBe(
            "fulfilled",
        );
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "racing")),
        ).toEqual([]);
        expect(
            await resolveRecordingAccess("receiver", "racing"),
        ).toMatchObject({ role: "owner" });
    });
    it("auto-attaches a participant's own already-filed recording but keeps the same-author requirement", async () => {
        await accept();
        const start = "2026-11-03T10:00:00Z";
        const end = "2026-11-03T11:00:00Z";
        const meeting = await prepareMeeting("receiver", {
            folderId: "source",
            title: "Acme agenda",
            start,
            end,
        });
        await insertRecording(database.db, {
            id: "matching",
            userId: "receiver",
            startTime: new Date(start),
        });
        await addRecordingToFolder({
            userId: "receiver",
            recordingId: "matching",
            folderId: "source",
        });
        await database.db.transaction((tx) =>
            attachArrivingRecordingInTx(
                tx,
                "receiver",
                "matching",
                "upload-match",
            ),
        );
        const detail = await getMeeting("receiver", meeting.id);
        if (detail.unchanged) throw new Error("Missing detail");
        expect(detail.recordingItemId).toBe("matching");
        const second = await prepareMeeting("receiver", {
            folderId: "source",
            title: "Acme next",
            start: "2026-11-04T10:00:00Z",
            end: "2026-11-04T11:00:00Z",
        });
        await insertRecording(database.db, {
            id: "different-owner",
            userId: "owner",
            startTime: new Date("2026-11-04T10:00:00Z"),
        });
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "different-owner",
            folderId: "source",
        });
        await database.db.transaction((tx) =>
            attachArrivingRecordingInTx(
                tx,
                "owner",
                "different-owner",
                "upload-other",
            ),
        );
        const untouched = await getMeeting("owner", second.id);
        if (untouched.unchanged) throw new Error("Missing detail");
        expect(untouched.recordingItemId).toBeNull();
    });
    it("gives the primary-email assignee receiver rights on contributed tasks without granting edits or Learn", async () => {
        await accept();
        await acceptOther();
        const id = await contribute();
        await database.db.insert(people).values({
            id: "contributor-assignee",
            userId: "receiver",
            displayName: encryptText("Jitka Dvořáková"),
            primaryEmail: encryptText("alex@example.com"),
            primaryEmailHash: lookupHash("alex@example.com"),
        });
        const author = await taskViewer(
            { id: "receiver", email: "lena@example.com" },
            localActor("receiver"),
        );
        const assignee = await taskViewer(
            { id: "owner", email: "alex@example.com" },
            localActor("owner"),
        );
        const observer = await taskViewer(
            { id: "other", email: "priya@example.com" },
            localActor("other"),
        );
        const task = await addTask(author, id, {
            text: "Acme follow-up",
            status: "open",
            assigneePersonId: "contributor-assignee",
        });
        expect(
            (await listRecordingTasks(assignee, id))?.tasks.find(
                (row) => row.id === task.id,
            ),
        ).toMatchObject({ canClose: true, canEdit: false });
        const done = await updateTask(assignee, task.id, {
            version: task.version,
            status: "done",
        });
        await updateTask(assignee, task.id, {
            version: done.version,
            status: "open",
        });
        await expect(
            updateTask(assignee, task.id, {
                version: done.version + 1,
                text: "Forged",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            (await listRecordingTasks(observer, id))?.tasks.find(
                (row) => row.id === task.id,
            ),
        ).toMatchObject({ canClose: false, canEdit: false });
        await expect(
            requireRecordingView("owner", id, "private"),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it.each([
        "owner",
        "receiver",
    ])("lets %s unfile a standalone contributed meeting through the route", async (actor) => {
        await accept();
        const meeting = await prepareMeeting("receiver", {
            folderId: "source",
            title: "Acme agenda",
        });
        const response = await unfileMeetingRoute(
            request(
                `meetings/${meeting.id}/folders/source`,
                "DELETE",
                undefined,
                actor,
            ),
            { params: Promise.resolve({ id: meeting.id, folderId: "source" }) },
        );
        expect(response.status).toBe(200);
        const detail = await getMeeting("receiver", meeting.id);
        if (detail.unchanged) throw new Error("Missing detail");
        expect(detail.folders).toEqual([]);
        await expect(getMeeting("owner", meeting.id)).rejects.toMatchObject({
            statusCode: 404,
        });
    });
    it("keeps a deferred capture unfiled when its share ends after placement resolution", async () => {
        const share = await accept();
        const folder = await assertCategorizableFolder("receiver", "source");
        await insertRecording(database.db, {
            id: "deferred",
            userId: "receiver",
        });
        await changeFolderShare("owner", share.id, {
            action: "remove",
            version: 1,
        });
        await database.db.transaction((tx) =>
            requestArrivalInTx(tx, {
                itemId: "deferred",
                userId: "receiver",
                folder,
                allowUnavailableFolder: true,
            }),
        );
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "deferred")),
        ).toEqual([]);
        expect(
            await resolveRecordingAccess("receiver", "deferred"),
        ).toMatchObject({ role: "owner" });
        expect(await isItemReceived("owner", "deferred")).toBe(false);
        await expect(
            database.db.transaction((tx) =>
                requestArrivalInTx(tx, {
                    itemId: "deferred",
                    userId: "receiver",
                    folder,
                }),
            ),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("round-trips a contributor's own agenda without exporting another participant's folder", async () => {
        await accept();
        const meeting = await prepareMeeting("receiver", {
            folderId: "source",
            title: "Acme portable agenda",
        });
        const [archived] = await collectArchivedMeetings({
            kind: "personal",
            userId: "receiver",
        });
        expect(archived.id).toBe(meeting.id);
        expect(archived.folderIds).toEqual([]);
        const result = await restoreMeetings("receiver", {
            meetings: [archived],
        });
        expect(result.skipped).toEqual([]);
        expect(result.restored).toHaveLength(1);
        const detail = await getMeeting("receiver", result.restored[0].id);
        if (detail.unchanged) throw new Error("Missing detail");
        expect(detail.title).toBe("Acme portable agenda");
        expect(detail.folders).toEqual([]);
        await expect(
            getMeeting("owner", result.restored[0].id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("preserves filing in the hosted legacy Public root", async () => {
        mockEnv.IS_HOSTED = true;
        await database.db.insert(recordingFolders).values({
            id: "legacy-public",
            userId: "owner",
            name: encryptText("Public"),
            nameHash: "public",
            kind: "public",
        });
        await addRecordingToFolder({
            userId: "owner",
            recordingId: "later",
            folderId: "legacy-public",
        });
        expect(
            await database.db
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "later")),
        ).toEqual([
            expect.objectContaining({
                userId: "owner",
                folderId: "legacy-public",
            }),
        ]);
        expect(await isItemReceived("receiver", "later")).toBe(false);
    });
});
