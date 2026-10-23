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
import { PATCH as folderAction } from "@/app/api/folder-shares/[id]/route";
import { POST as restoreRoute } from "@/app/api/folder-shares/restore/route";
import { PUT as settingsRoute } from "@/app/api/folders/[id]/default-profiles/route";
import {
    DELETE as deleteRoute,
    PATCH as renameRoute,
} from "@/app/api/folders/[id]/route";
import {
    POST as inviteRoute,
    GET as listRoute,
} from "@/app/api/folders/[id]/shares/route";
import { POST as createRoute } from "@/app/api/folders/route";
import { POST as assignRoute } from "@/app/api/recordings/[id]/folders/route";
import { GET as invitationsRoute } from "@/app/api/shares/route";
import {
    isItemReceived,
    receivedItemCondition,
} from "@/db/queries/item-shares";
import {
    chatterItems,
    folderShares,
    itemShares,
    mailMessages,
    people,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
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
import { folderCondition } from "@/lib/folders/condition";
import {
    addRecordingToFolder,
    deleteFolder,
    listFolderOrganization,
    listPersonalFolderOrganization,
    moveFolder,
    removeRecordingFromFolder,
    renameFolder,
} from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { resolveMailAccess } from "@/lib/mail/access";
import { loadReceivedMailRows } from "@/lib/mail/list";
import { mcpItemCondition } from "@/lib/mcp/scope";
import { ALL_TOOLS } from "@/lib/mcp/tools";
import { requestArrivalInTx } from "@/lib/pipeline/arrival";
import { searchApp } from "@/lib/search/app-search";
import { searchItems } from "@/lib/search/item-search";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import {
    changeFolderShare,
    inviteToFolder,
    listFolderShares,
    listMyFolderInvitations,
} from "@/lib/sharing/folder-shares";
import { changePersonShare, inviteToItem } from "@/lib/sharing/person-shares";
import { restoreArchivedFolderShares } from "@/lib/sharing/restore-folder-shares";
import { taskViewer } from "@/lib/tasks/access";
import {
    addTask,
    countNewTasks,
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
        KNOWLEDGE_MEMORY_MB: 64,
        MAIL_DOMAIN: "mail.example.com",
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
vi.mock("@/lib/folder-exports/jobs", () => ({
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
    it("requires confirmation to publish a folder and atomically ends its person shares", async () => {
        await accept();
        for (const id of ["audio", "nested"])
            await insertTranscript(database.db, id, "owner", {
                text: "Project planning",
            });
        await insertRecording(database.db, {
            id: "colleague-audio",
            userId: "other",
            title: "Colleague recording",
        });
        await database.db.insert(recordingFolders).values({
            id: "colleague-folder",
            userId: "other",
            name: encryptText("Colleague folder"),
            nameHash: "colleague-folder",
        });
        const [direct] = await inviteToItem("other", "colleague-audio", [
            "owner",
        ]);
        await changePersonShare("owner", direct.id, {
            action: "accept",
            version: 0,
            folderId: "source",
        });
        const [incoming] = await inviteToFolder("other", "colleague-folder", [
            "owner",
        ]);
        await changeFolderShare("owner", incoming.id, {
            action: "accept",
            version: 0,
            name: "My attachment",
            parentId: "source",
        });
        await expect(
            moveFolder({
                userId: "owner",
                folderId: "source",
                parentId: "org-folder",
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await visibleIds()).toEqual(["audio", "mail"]);
        await moveFolder({
            userId: "owner",
            folderId: "source",
            parentId: "org-folder",
            endPersonShares: true,
        });
        expect(
            await database.db
                .select()
                .from(folderShares)
                .where(eq(folderShares.userId, "owner")),
        ).toEqual([]);
        expect(
            await database.db.select().from(receivedFolderAttachments),
        ).toMatchObject([{ userId: "owner", parentId: null }]);
        expect(
            await database.db
                .select()
                .from(itemShares)
                .where(eq(itemShares.receiverUserId, "owner")),
        ).toMatchObject([
            {
                itemId: "colleague-audio",
                state: "accepted",
                filingFolderId: null,
            },
        ]);
        expect(
            await resolveRecordingAccess("receiver", "colleague-audio"),
        ).toBeNull();
        expect(
            (await listFolderOrganization("owner")).folders.find(
                (folder) => folder.id === "source",
            )?.scope,
        ).toBe("org");
        expect((await resolveRecordingAccess("other", "audio"))?.shared).toBe(
            true,
        );
        expect((await resolveRecordingAccess("other", "nested"))?.shared).toBe(
            true,
        );
        expect(events).toHaveBeenCalledWith("receiver");
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
});
