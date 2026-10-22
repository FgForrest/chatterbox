import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
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
import { lockPrivateFolderTree } from "@/db/queries/private-folder-tree";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import {
    deleteFolder,
    listFolderOrganization,
    moveFolder,
} from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { TASK_TOOLS } from "@/lib/mcp/tools/tasks";
import { searchTasks } from "@/lib/search/app-search";
import type { StorageProvider } from "@/lib/storage/types";
import type { TaskViewer } from "@/lib/tasks/access";
import { personalTasksForArchive } from "@/lib/tasks/archive";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import {
    addTask,
    countNewTasks,
    createPersonalTask,
    followTask,
    getCallerTask,
    getVisibleTask,
    listTasks,
    type TaskTab,
    updateTask,
} from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, proxy } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        ref,
        proxy: new Proxy(
            {},
            {
                get: (_target, key) => {
                    const value = ref.current?.[key];
                    return typeof value === "function"
                        ? value.bind(ref.current)
                        : value;
                },
            },
        ),
    };
});
vi.mock("@/db", () => ({ db: proxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
        AUTHZ_MODE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "assignee-tasks-tests",
        DATABASE_URL: "postgres://unused",
        APP_URL: "https://example.test",
        MCP_SERVICE_CLIENTS: [],
        MCP_ALLOWED_CLIENTS: [],
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    assertOrgScopeWritable: vi.fn(),
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/authz/curator", () => ({
    userCuratesOrganizationNow: async (id: string) =>
        id === "curator" || id === "org",
    actsForOrganization: async (actor: { actorId: string }) =>
        actor.actorId === "curator" || actor.actorId === "org",
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: async () => true }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const url = getTestDatabaseUrl();
function viewer(userId: string): TaskViewer {
    return {
        userId,
        emailHash: lookupHash(`${userId}@example.test`),
        isOrg: userId === "org",
        isCurator: userId === "curator" || userId === "org",
        orgUserId: "org",
    };
}
function caller(userId: string, mail = false): McpCaller {
    const base = {
        subject: userId,
        clientId: "test",
        roles: new Set([
            "tasks:read",
            "tasks:write",
            ...(mail ? ["mail:read" as const] : []),
        ] as const),
        orgUserId: "org",
    };
    return userId === "org"
        ? { ...base, kind: "service" }
        : { ...base, kind: "user", userId, email: `${userId}@example.test` };
}
async function call(
    name: string,
    userId: string,
    input: Record<string, unknown>,
    mail = false,
) {
    const tool = [...TASK_TOOLS, ...RECORDING_TOOLS].find(
        (tool) => tool.name === name,
    );
    if (!tool) throw new Error("Missing task tool");
    const identity = caller(userId, mail);
    const result = await tool.run(
        { caller: identity, touched: [] },
        z.object(tool.input(identity)).parse(input),
    );
    return z.object(tool.output).parse(result);
}

vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/org/events", () => ({ notifyOrgChange: vi.fn() }));
vi.mock("@/lib/mail/address-blocking", () => ({
    blockFolderAddressesInTx: vi.fn(),
}));

describe.skipIf(!url)("#253 own tasks in private folders", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "own_task_folders",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values(
                ["author", "member", "curator", "org"].map((id) => ({
                    id,
                    email: `${id}@example.test`,
                    name: id,
                    role: id === "org" ? ("org" as const) : ("user" as const),
                })),
            );
        for (const [id, userId, parentId, kind, name] of [
            ["private", "author", null, "private", "Private"],
            ["public", "author", null, "public", "Public"],
            ["projects", "author", "private", "custom", "Projects"],
            ["drafts", "author", "projects", "custom", "Drafts"],
            ["later", "author", "private", "custom", "Later"],
            ["foreign-private", "member", null, "private", "Private"],
            ["foreign", "member", "foreign-private", "custom", "Foreign"],
            ["team", "org", null, "public", "Organization"],
            ["team-project", "org", "team", "custom", "Team project"],
        ] as const)
            await db()
                .insert(recordingFolders)
                .values({
                    id,
                    userId,
                    parentId,
                    kind,
                    name: encryptText(name),
                    nameHash: lookupHash(name),
                });
        await db()
            .insert(chatterItems)
            .values({
                id: "mail",
                userId: "author",
                kind: "mail",
                title: encryptText("Planning"),
                occurredAt: new Date("2026-10-22T10:00:00Z"),
            });
    });
    const list = (
        folderId: string | null = null,
        id = "author",
        tab: TaskTab = "mine",
    ) =>
        listTasks(viewer(id), {
            tab,
            state: "all",
            folderId,
            due: null,
            today: null,
            sort: "created",
        });
    const own = (folderId?: string | null, text = "Prepare the draft") =>
        createPersonalTask(viewer("author"), { text, folderId });

    it("files, moves and clears an own task with current versions and folder paths", async () => {
        let task = await own("drafts");
        expect(task.folder).toEqual({
            id: "drafts",
            name: "Drafts",
            path: "Private / Projects / Drafts",
        });
        expect(
            (await getCallerTask(viewer("author"), task.id))?.folder,
        ).toEqual(task.folder);
        task = await updateTask(viewer("author"), task.id, {
            version: task.version,
            folderId: "later",
        });
        expect(task.folder?.id).toBe("later");
        await expect(
            updateTask(viewer("author"), task.id, {
                version: 0,
                folderId: null,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        task = await updateTask(viewer("author"), task.id, {
            version: task.version,
            folderId: null,
        });
        expect(task.folder).toBeNull();
        expect(task.version).toBe(2);
        expect(await countNewTasks(viewer("author"))).toBe(0);
        expect((await listFolderOrganization("author")).assignments).toEqual(
            [],
        );
    });
    it.each([
        "private",
        "team",
        "team-project",
        "foreign",
        "public",
        "missing",
    ])("refuses %s on creation and update without changing the task", async (folderId) => {
        await expect(own(folderId)).rejects.toMatchObject({ statusCode: 404 });
        const task = await own("projects");
        await expect(
            updateTask(viewer("author"), task.id, {
                version: task.version,
                folderId,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            (await getCallerTask(viewer("author"), task.id))?.folder?.id,
        ).toBe("projects");
        expect((await list()).length).toBe(1);
    });
    it.each([
        "projects",
        null,
    ])("refuses a folder change on an item task (%s)", async (folderId) => {
        const task = await addTask(viewer("author"), "mail", {
            text: "Item task",
            status: "open",
        });
        await expect(
            updateTask(viewer("author"), task.id, {
                version: task.version,
                folderId,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(
            (await getCallerTask(viewer("author"), task.id))?.folder,
        ).toBeNull();
    });
    it("filters Mine through private subfolders, the Private root, Organization folders and All folders", async () => {
        const direct = await own("projects", "Direct");
        const nested = await own("drafts", "Nested");
        const elsewhere = await own("later", "Elsewhere");
        const unfiled = await own(null, "Unfiled");
        const ids = async (folderId: string | null) =>
            (await list(folderId)).map((task) => task.id).sort();
        expect(await ids("projects")).toEqual([direct.id, nested.id].sort());
        expect(await ids("drafts")).toEqual([nested.id]);
        expect(await ids("later")).toEqual([elsewhere.id]);
        expect(await ids("team")).toEqual([]);
        expect(await ids("foreign")).toEqual([]);
        expect(await ids(null)).toEqual(
            [direct.id, nested.id, elsewhere.id, unfiled.id].sort(),
        );
        expect(await ids("private")).toEqual(await ids(null));
        expect(await list("projects", "author", "followed")).toEqual([]);
        await followTask(viewer("author"), direct.id, true);
        expect(
            (await list(null, "author", "followed")).map((task) => task.id),
        ).toEqual([direct.id]);
        expect(await list("projects", "author", "followed")).toEqual([]);
        await db()
            .insert(recordingFolderAssignments)
            .values({ itemId: "mail", userId: "author", folderId: "drafts" });
        const item = await addTask(viewer("author"), "mail", {
            text: "Unassigned item task",
            status: "open",
        });
        expect(
            (await list("projects", "author", "followed")).map(
                (task) => task.id,
            ),
        ).toEqual([item.id]);
    });
    it.each([
        "member",
        "curator",
        "org",
    ])("keeps a filed task private from %s in lists, detail, search and MCP", async (id) => {
        const task = await own("projects");
        expect(await list(null, id)).toEqual([]);
        expect(await getVisibleTask(viewer(id), task.id)).toBeNull();
        expect((await searchTasks(viewer(id), "draft")).hits).toEqual([]);
        expect(
            (await call("list_tasks", id, { folder: "projects" })).tasks,
        ).toEqual([]);
    });
    it("deletes a folder subtree without deleting tasks and invalidates their stale versions", async () => {
        const direct = await own("projects");
        const nested = await own("drafts");
        const other = await own("later");
        await deleteFolder("author", "projects");
        for (const task of [direct, nested]) {
            expect(
                await getCallerTask(viewer("author"), task.id),
            ).toMatchObject({ folder: null, version: task.version + 1 });
            await expect(
                updateTask(viewer("author"), task.id, {
                    version: task.version,
                    folderId: "later",
                }),
            ).rejects.toMatchObject({ statusCode: 409 });
        }
        expect(
            (await getCallerTask(viewer("author"), other.id))?.folder?.id,
        ).toBe("later");
        expect((await list()).length).toBe(3);
    });
    it("keeps filing on private moves and refuses cross-owner moves into Organization", async () => {
        const task = await own("drafts");
        await moveFolder({
            userId: "author",
            folderId: "projects",
            parentId: "later",
        });
        expect(
            (await getCallerTask(viewer("author"), task.id))?.folder?.path,
        ).toBe("Private / Later / Projects / Drafts");
        await expect(
            moveFolder({
                userId: "author",
                folderId: "projects",
                parentId: "team",
                canCurate: true,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(
            (await getCallerTask(viewer("author"), task.id))?.folder?.id,
        ).toBe("drafts");
    });
    it("clears a subtree's tasks atomically when moved outside Private and preserves privacy", async () => {
        const task = await own("drafts");
        await expect(
            moveFolder({
                userId: "author",
                folderId: "projects",
                parentId: "public",
                beforeId: "missing",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(await getCallerTask(viewer("author"), task.id)).toMatchObject({
            folder: { id: "drafts" },
            version: 0,
        });
        await moveFolder({
            userId: "author",
            folderId: "projects",
            parentId: "public",
        });
        expect(await getCallerTask(viewer("author"), task.id)).toMatchObject({
            folder: null,
            version: 1,
        });
        await expect(own("drafts")).rejects.toMatchObject({ statusCode: 404 });
        for (const id of ["member", "curator", "org"])
            expect(await getVisibleTask(viewer(id), task.id)).toBeNull();
    });
    it("reports folder context in app search", async () => {
        const task = await own("drafts");
        expect(
            (await searchTasks(viewer("author"), "draft")).hits,
        ).toMatchObject([{ id: task.id, folder: { name: "Drafts" } }]);
    });
    it("serializes concurrent filing and a move outside Private without leaving an invalid folder reference", async () => {
        const task = await own("later");
        let release: () => void = () => {};
        let ready: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const locked = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const blocker = db().transaction(async (tx) => {
            await lockPrivateFolderTree(tx, "author");
            ready();
            await held;
        });
        await locked;
        const filing = updateTask(viewer("author"), task.id, {
            version: 0,
            folderId: "drafts",
        });
        const moving = moveFolder({
            userId: "author",
            folderId: "projects",
            parentId: "public",
        });
        release();
        const results = await Promise.allSettled([filing, moving]);
        await blocker;
        const [folder] = await db()
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.id, "projects"));
        const [stored] = await db()
            .select()
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, "author"),
                ),
            );
        if (folder.parentId === "public")
            expect(stored.folderId).not.toBe("drafts");
        else {
            expect(results[1].status).toBe("rejected");
            await moveFolder({
                userId: "author",
                folderId: "projects",
                parentId: "public",
            });
            expect(
                (await getCallerTask(viewer("author"), task.id))?.folder,
            ).toBeNull();
        }
    });
    it("supports MCP folder ids from list_folders, create, update, clear and list subtree filters", async () => {
        const folders = await call("list_folders", "author", {});
        expect(folders.folders).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "drafts", scope: "personal" }),
            ]),
        );
        const made = await call("create_task", "author", {
            text: "MCP task",
            folder: "drafts",
        });
        const task = made.task as { id: string; version: number };
        expect(made.task).toMatchObject({
            folder: {
                id: "drafts",
                name: "Drafts",
                path: "Private / Projects / Drafts",
            },
        });
        await call("follow_task", "author", { task: task.id, follow: true });
        expect(
            (
                await call("list_tasks", "author", {
                    list: "followed",
                    folder: "projects",
                })
            ).tasks,
        ).toEqual([]);
        expect(
            (
                await call("list_tasks", "author", {
                    list: "mine",
                    folder: "projects",
                })
            ).tasks,
        ).toMatchObject([{ id: task.id }]);
        expect(
            (await call("list_tasks", "author", { folder: "team" })).tasks,
        ).toEqual([]);
        const moved = await call("update_task", "author", {
            task: task.id,
            version: 0,
            folder: "later",
        });
        expect(moved.task).toMatchObject({
            folder: { id: "later" },
            version: 1,
        });
        const cleared = await call("update_task", "author", {
            task: task.id,
            version: 1,
            folder: null,
        });
        expect(cleared.task).toMatchObject({ folder: null });
    });
    it.each([
        "private",
        "team-project",
        "foreign",
    ])("refuses %s through MCP create and update", async (folder) => {
        await expect(
            call("create_task", "author", { text: "Refused", folder }),
        ).rejects.toMatchObject({ outcome: "not_found" });
        const task = await own();
        await expect(
            call("update_task", "author", {
                task: task.id,
                version: 0,
                folder,
            }),
        ).rejects.toMatchObject({ outcome: "not_found" });
    });
    it("refuses MCP filing for item tasks and own-task creation for the service account", async () => {
        const task = await addTask(viewer("author"), "mail", {
            text: "Item",
            status: "open",
        });
        await expect(
            call("update_task", "author", {
                task: task.id,
                version: 0,
                folder: "drafts",
            }),
        ).rejects.toMatchObject({ outcome: "denied" });
        await expect(
            call("create_task", "org", { text: "Refused", folder: "drafts" }),
        ).rejects.toMatchObject({ outcome: "denied" });
    });
    it.each([
        true,
        false,
    ])("round trips the archive folder reference with restored folder present=%s", async (included) => {
        const task = await own("drafts");
        const personal = await personalTasksForArchive({
            kind: "personal",
            userId: "author",
        });
        expect(personal[0].folderId).toBe("drafts");
        expect(
            await personalTasksForArchive({
                kind: "organization",
                orgUserId: "org",
            }),
        ).toEqual([]);
        await db()
            .delete(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.userId, "author"),
                    eq(recordingTasks.id, task.id),
                ),
            );
        await restoreTaskArchive(viewer("author"), {
            personal,
            folders: included ? [{ id: "drafts", restoredId: "later" }] : [],
        });
        expect(
            (await getCallerTask(viewer("author"), task.id))?.folder?.id ??
                null,
        ).toBe(included ? "later" : null);
    });
    it.each([
        "private",
        "foreign",
        "team-project",
        "public",
    ])("refuses a restore mapping to %s", async (restoredId) => {
        const task = await own("drafts");
        const personal = await personalTasksForArchive({
            kind: "personal",
            userId: "author",
        });
        await db().delete(recordingTasks).where(eq(recordingTasks.id, task.id));
        await expect(
            restoreTaskArchive(viewer("author"), {
                personal,
                folders: [{ id: "drafts", restoredId }],
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await list()).toEqual([]);
    });
    it("writes own-task folder references alongside the personal folder tree in the ZIP", async () => {
        const task = await own("drafts");
        let bytes = Buffer.alloc(0);
        const storage: StorageProvider = {
            uploadFile: async () => "",
            downloadFile: async () => Buffer.alloc(0),
            downloadStream: async () => Readable.from([]),
            uploadStream: async (_key, stream) => {
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
            scope: { kind: "personal", userId: "author" },
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
        expect(await read("tasks/personal.json")).toMatchObject([
            { id: task.id, folderId: "drafts" },
        ]);
        expect(await read("organization/folders.json")).toMatchObject({
            folders: expect.arrayContaining([
                expect.objectContaining({ id: "drafts" }),
            ]),
        });
    });
});
