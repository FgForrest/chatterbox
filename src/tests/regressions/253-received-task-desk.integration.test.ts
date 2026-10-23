import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { Open } from "unzipper";
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
import {
    chatterItems,
    itemShares,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskFollowers,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { TASK_TOOLS } from "@/lib/mcp/tools/tasks";
import { searchTasks } from "@/lib/search/app-search";
import { changePersonShare, inviteToItem } from "@/lib/sharing/person-shares";
import type { StorageProvider } from "@/lib/storage/types";
import {
    type TaskViewer,
    taskViewer,
    taskViewerById,
} from "@/lib/tasks/access";
import { searchAssignedMergeCandidates } from "@/lib/tasks/proposals";
import {
    addTask,
    createPersonalTask,
    followTask,
    getCallerTask,
    getVisibleTask,
    listRecordingTasks,
    listTasks,
    mergeTaskIntoTask,
    previewTaskMerge,
    updateTask,
} from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";
import {
    insertRecording,
    serviceCaller,
    userCaller,
} from "@/tests/mcp/fixtures";

const { ref } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
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
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "received-task-desk-tests",
        DATABASE_URL: "postgres://unused",
        APP_URL: "https://example.test",
        MAIL_DOMAIN: "mail.example.test",
        MAIL_ADDRESS_HASH_SECRET: "test-mail-address-hash-secret",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: vi.fn(),
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        ["curator", "org"].includes(id),
    actsForOrganization: async (actor: { actorId: string }) =>
        ["curator", "org"].includes(actor.actorId),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/events/personal", () => ({ notifyPersonShareChanged: vi.fn() }));
vi.mock("@/lib/notifications/person-share", () => ({
    sendPersonShareInvitation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: async () => true }));

const url = getTestDatabaseUrl();
describe.skipIf(!url)("#253 task desk with accepted person shares", () => {
    let database: TestPostgresDatabase;
    let owner: TaskViewer;
    let receiver: TaskViewer;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "received_task_desk",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        await database.db.delete(users);
        await database.db.insert(users).values(
            ["owner", "receiver", "member", "curator", "org"].map((id) => ({
                id,
                name: id === "owner" ? "Mira Vale" : id,
                email: `${id}@example.test`,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
        await insertRecording(database.db, { id: "audio", userId: "owner" });
        await database.db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Mail source"),
            occurredAt: new Date(),
        });
        await database.db.insert(people).values({
            id: "assigned",
            userId: "org",
            displayName: encryptText("Ari Fen"),
            primaryEmailHash: lookupHash("receiver@example.test"),
        });
        await database.db.insert(recordingFolders).values({
            id: "team",
            userId: "org",
            name: encryptText("Team"),
            nameHash: "team",
            kind: "public",
        });
        await database.db.insert(recordingFolders).values(
            ["receiver", "curator"].map((id) => ({
                id: `${id}-folder`,
                userId: id,
                name: encryptText("Private filing"),
                nameHash: "filing",
                kind: "private" as const,
            })),
        );
        owner = await taskViewer({ id: "owner", email: "owner@example.test" });
        receiver = await taskViewer({
            id: "receiver",
            email: "receiver@example.test",
        });
    });
    async function share(itemId: string) {
        const [invitation] = await inviteToItem("owner", itemId, ["receiver"]);
        await changePersonShare("receiver", invitation.id, {
            action: "accept",
            folderId: "receiver-folder",
            version: invitation.version,
        });
        return invitation.id;
    }
    const list = (viewer: TaskViewer, tab: "mine" | "followed") =>
        listTasks(viewer, {
            tab,
            state: "all",
            folderId: null,
            due: null,
            today: null,
            sort: "created",
        });
    async function task(itemId: string, assigned = true) {
        return addTask(owner, itemId, {
            text: "Received task sentinel",
            status: "open",
            assigneePersonId: assigned ? "assigned" : null,
        });
    }
    async function call(
        name: string,
        args: Record<string, unknown>,
        id = "receiver",
        mail = true,
    ) {
        const tool = TASK_TOOLS.find((entry) => entry.name === name);
        if (!tool) throw new Error("Missing task tool");
        const roles = [
            "tasks:read",
            "tasks:write",
            ...(mail ? ["mail:read" as const] : []),
        ] as const;
        const caller =
            id === "org"
                ? serviceCaller("org", [...roles])
                : userCaller(id, `${id}@example.test`, [...roles], "org");
        return z
            .object(tool.output)
            .parse(
                await tool.run(
                    { caller, touched: [] },
                    z.object(tool.input(caller)).parse(args),
                ),
            );
    }

    it.each([
        "audio",
        "mail",
    ])("keeps assigned receiver note rights and refuses content edits on %s", async (itemId) => {
        const assigned = await task(itemId);
        const unassigned = await task(itemId, false);
        await share(itemId);
        const detail = await listRecordingTasks(receiver, itemId);
        expect(detail?.tasks).toHaveLength(2);
        expect((await list(receiver, "mine")).map((row) => row.id)).toEqual([
            assigned.id,
        ]);
        expect(await getVisibleTask(receiver, assigned.id)).toMatchObject({
            receivedOwnerName: "Mira Vale",
            canEdit: false,
            canClose: true,
            canMerge: false,
            recording: { view: "received" },
            evidence: { view: "received" },
        });
        const written = await updateTask(receiver, assigned.id, {
            version: 0,
            status: "done",
            note: "Receiver outcome",
        });
        expect(written).toMatchObject({
            note: "Receiver outcome",
            noteBy: { id: "receiver" },
            status: "done",
        });
        const [stored] = await database.db
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.id, assigned.id));
        expect(stored.note).not.toBe("Receiver outcome");
        expect(decryptText(stored.note)).toBe("Receiver outcome");
        expect(written.noteUpdatedAt).toBeTruthy();
        await updateTask(receiver, assigned.id, {
            version: written.version,
            note: "Later outcome",
            status: "open",
        });
        for (const change of [
            { text: "Forbidden" },
            { dueDate: "2026-11-01" },
            { assigneePersonId: null },
            { status: "dropped" as const },
        ])
            await expect(
                updateTask(receiver, assigned.id, { version: 2, ...change }),
            ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            updateTask(receiver, unassigned.id, {
                version: 0,
                note: "Forbidden",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await followTask(receiver, unassigned.id, true);
        await expect(
            call("update_task", {
                task: unassigned.id,
                version: 0,
                note: "Forbidden",
            }),
        ).rejects.toMatchObject({ outcome: "denied" });
        expect(
            await listRecordingTasks(await taskViewerById("receiver"), itemId),
        ).toBeNull();
    });

    it.each([
        "audio",
        "mail",
    ])("hides followed %s tasks after removal, decline or item deletion", async (itemId) => {
        const saved = await task(itemId, false);
        const shareId = await share(itemId);
        await call("follow_task", { task: saved.id, follow: true });
        expect(await getCallerTask(receiver, saved.id)).toMatchObject({
            following: true,
            canClose: false,
        });
        expect(await list(receiver, "mine")).toEqual([]);
        expect((await list(receiver, "followed")).map((row) => row.id)).toEqual(
            [saved.id],
        );
        await changePersonShare("owner", shareId, {
            action: "remove",
            version: 1,
        });
        for (const state of ["removed", "declined", "accepted"] as const) {
            await database.db
                .update(itemShares)
                .set({ state })
                .where(eq(itemShares.id, shareId));
            if (state === "accepted")
                await database.db
                    .update(chatterItems)
                    .set({ deletedAt: new Date() })
                    .where(eq(chatterItems.id, itemId));
            expect(await list(receiver, "followed")).toEqual([]);
            expect(await getVisibleTask(receiver, saved.id)).toBeNull();
            expect(await getCallerTask(receiver, saved.id)).toBeNull();
            expect(
                (await call("list_tasks", { list: "followed" })).tasks,
            ).toEqual([]);
            expect(
                (await call("search_tasks", { query: "sentinel" })).tasks,
            ).toEqual([]);
            await expect(
                followTask(receiver, saved.id, true),
            ).rejects.toMatchObject({ statusCode: 404 });
        }
        await database.db
            .update(chatterItems)
            .set({ deletedAt: null })
            .where(eq(chatterItems.id, itemId));
        expect((await list(receiver, "followed")).map((row) => row.id)).toEqual(
            [saved.id],
        );
        expect(
            await database.db
                .select()
                .from(taskFollowers)
                .where(eq(taskFollowers.taskId, saved.id)),
        ).toHaveLength(1);
    });

    it.each([
        "audio",
        "mail",
    ])("refuses both merge directions and previews for a received %s task", async (itemId) => {
        const received = await task(itemId);
        await share(itemId);
        const own = await createPersonalTask(receiver, {
            text: "Private reminder",
        });
        const query = { text: "", offset: 0, limit: 20 };
        expect(
            await searchAssignedMergeCandidates(receiver, received.id, query),
        ).toBeNull();
        expect(
            (await searchAssignedMergeCandidates(receiver, own.id, query))
                ?.candidates,
        ).toEqual([]);
        for (const [source, target] of [
            [received, own],
            [own, received],
        ]) {
            await expect(
                previewTaskMerge(receiver, source.id, target.id),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(
                mergeTaskIntoTask(receiver, source.id, target.id, {
                    sourceVersion: 0,
                    targetVersion: 0,
                    confirmPrivateToShared: true,
                }),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(
                call("merge_tasks", {
                    keep: target.id,
                    merge: source.id,
                    keep_version: 0,
                    merge_version: 0,
                    confirm_private_to_shared: true,
                }),
            ).rejects.toMatchObject({ outcome: "denied" });
        }
        expect((await getVisibleTask(receiver, own.id))?.text).toBe(
            "Private reminder",
        );
        expect((await getVisibleTask(receiver, received.id))?.text).toBe(
            received.text,
        );
    });

    it.each([
        "audio",
        "mail",
    ])("preserves Organization curator rights while the received %s item is published", async (itemId) => {
        const saved = await task(itemId, false);
        await share(itemId);
        const curator = await taskViewer({
            id: "curator",
            email: "curator@example.test",
        });
        const invitations = await inviteToItem("owner", itemId, ["curator"]);
        const invitation = invitations.find(
            (entry) => entry.receiverUserId === "curator",
        );
        if (!invitation) throw new Error("Missing curator invitation");
        await changePersonShare("curator", invitation.id, {
            action: "accept",
            folderId: "curator-folder",
            version: 0,
        });
        expect(await getVisibleTask(curator, saved.id)).toMatchObject({
            canEdit: false,
            canClose: false,
            canMerge: false,
        });
        await database.db
            .insert(recordingFolderAssignments)
            .values({ itemId, userId: "owner", folderId: "team" });
        expect(await getVisibleTask(curator, saved.id)).toMatchObject({
            canEdit: true,
            canClose: true,
            canMerge: true,
            recording: { view: "org" },
        });
        const updated = await updateTask(curator, saved.id, {
            version: 0,
            text: "Organization edit",
        });
        await database.db.delete(recordingFolderAssignments);
        expect(await getVisibleTask(curator, saved.id)).toMatchObject({
            canEdit: false,
            canClose: false,
            recording: { view: "received" },
        });
        await expect(
            updateTask(curator, saved.id, {
                version: updated.version,
                note: "Forbidden",
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("keeps own tasks author-only despite accepted person shares on the author's items", async () => {
        await share("audio");
        const own = await createPersonalTask(owner, { text: "Own sentinel" });
        expect(
            (await call("list_tasks", { list: "mine" }, "owner")).tasks,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: own.id, kind: "personal" }),
            ]),
        );
        for (const id of ["receiver", "member", "curator", "org"]) {
            const viewer = await taskViewer({
                id,
                email: `${id}@example.test`,
            });
            expect(await getVisibleTask(viewer, own.id)).toBeNull();
            expect(await getCallerTask(viewer, own.id)).toBeNull();
            expect(await list(viewer, "mine")).toEqual([]);
            expect(await list(viewer, "followed")).toEqual([]);
            expect((await searchTasks(viewer, "sentinel")).hits).toEqual([]);
            expect((await call("list_tasks", {}, id)).tasks).toEqual([]);
            expect(
                (await call("search_tasks", { query: "sentinel" }, id)).tasks,
            ).toEqual([]);
            await expect(
                followTask(viewer, own.id, true),
            ).rejects.toMatchObject({ statusCode: id === "org" ? 403 : 404 });
            await expect(
                updateTask(viewer, own.id, { version: 0, status: "done" }),
            ).rejects.toMatchObject({ statusCode: 404 });
        }
    });

    it.each([
        "audio",
        "mail",
    ])("keeps received view and owner in MCP for %s, with note redaction", async (itemId) => {
        const saved = await task(itemId);
        await share(itemId);
        const written = await call("update_task", {
            task: saved.id,
            version: 0,
            note: "Receiver outcome sentinel",
        });
        expect(written.task).toMatchObject({
            can_close: true,
            can_edit: false,
            can_merge: false,
            received_owner_name: "Mira Vale",
        });
        for (const name of ["list_tasks", "search_tasks"]) {
            const args =
                name === "list_tasks"
                    ? { list: "mine" }
                    : { query: "sentinel" };
            const result = await call(name, args);
            expect(result.tasks).toEqual([
                expect.objectContaining({
                    id: saved.id,
                    received_owner_name: "Mira Vale",
                    note: "Receiver outcome sentinel",
                    url: expect.stringContaining("view=received"),
                }),
            ]);
            const hidden = await call(name, args, "receiver", false);
            expect(hidden.tasks).toEqual([
                expect.objectContaining({
                    id: saved.id,
                    note:
                        itemId === "mail" ? null : "Receiver outcome sentinel",
                }),
            ]);
        }
    });

    it("archives own tasks and follows without received item content", async () => {
        const received = await task("audio");
        await share("audio");
        const own = await createPersonalTask(receiver, {
            text: "Archived reminder",
        });
        await updateTask(receiver, own.id, {
            version: 0,
            note: "Archived own outcome",
        });
        await followTask(receiver, received.id, true);
        let bytes = Buffer.alloc(0);
        const storage: StorageProvider = {
            uploadFile: async () => "",
            downloadFile: async () => Buffer.alloc(0),
            downloadStream: async () => Readable.from([]),
            uploadStream: async (_, stream) => {
                const parts: Buffer[] = [];
                for await (const part of stream) parts.push(Buffer.from(part));
                bytes = Buffer.concat(parts);
                return "archive";
            },
            exists: async () => false,
            getSignedUrl: async () => "",
            deleteFile: async () => {},
            testConnection: async () => true,
        };
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "receiver" },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "archive",
        });
        const zip = await Open.buffer(bytes);
        const read = async (path: string) =>
            JSON.parse(
                (
                    await zip.files.find((file) => file.path === path)?.buffer()
                )?.toString() ?? "null",
            );
        expect((await read("manifest.json")).recordings).toEqual([]);
        expect(await read("tasks/personal.json")).toEqual([
            expect.objectContaining({
                id: own.id,
                note: "Archived own outcome",
            }),
        ]);
        expect(await read("tasks/follows.json")).toEqual([
            expect.objectContaining({ taskId: received.id }),
        ]);
        for (const file of zip.files)
            expect((await file.buffer()).toString()).not.toContain(
                "Received task sentinel",
            );
    });
});
