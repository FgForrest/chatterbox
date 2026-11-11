import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tasks/route";
import { listTaskFolderIds } from "@/db/queries/task-list";
import {
    chatterItems,
    folderShares,
    itemShares,
    people,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    restrictedFolderMembers,
    taskFollowers,
    taskUnfollows,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { listRecordingFolderTrees } from "@/lib/folders/folders";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { TaskViewer } from "@/lib/tasks/access";
import { taskFilterFolders } from "@/lib/tasks/folder-filter";
import { listTasks, type TaskTab } from "@/lib/tasks/tasks";
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
        BETTER_AUTH_SECRET: "folder-filter-test",
        DATABASE_URL: "postgres://unused",
        APP_URL: "https://example.test",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => "org",
    isOrgAccount: async (id: string) => id === "org",
    assertOrgScopeWritable: vi.fn(),
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
}));
vi.mock("@/lib/tasks/route-helpers", () => ({
    requireTaskViewer: async () => viewer(),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

function viewer(userId = "viewer"): TaskViewer {
    return {
        userId,
        emailHash: lookupHash(`${userId}@example.test`),
        isOrg: userId === "org",
        isCurator: userId === "org",
        orgUserId: "org",
        includeReceived: true,
    };
}
const url = getTestDatabaseUrl();
describe.skipIf(!url)("#397 task folder options", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "task_folder_filter",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
        const db = database.db;
        await db.insert(users).values(
            ["viewer", "other", "org"].map((id) => ({
                id,
                email: `${id}@example.test`,
                name: id,
                role: id === "org" ? ("org" as const) : ("user" as const),
            })),
        );
        for (const [id, userId, parentId, kind] of [
            ["private", "viewer", null, "private"],
            ["parent", "viewer", "private", "custom"],
            ["mine", "viewer", "parent", "custom"],
            ["own", "viewer", "parent", "custom"],
            ["followed", "viewer", "parent", "custom"],
            ["own-followed", "viewer", "parent", "custom"],
            ["filed-share", "viewer", "parent", "custom"],
            ["empty", "viewer", "parent", "custom"],
            ["excluded", "viewer", "private", "custom"],
            ["other-private", "other", null, "private"],
            ["person-shared", "other", "other-private", "custom"],
            ["person-child", "other", "person-shared", "custom"],
            ["team", "org", null, "public"],
            ["all", "org", "team", "custom"],
            ["readable", "org", "team", "custom"],
            ["unreadable", "org", "team", "custom"],
            ["withheld", "org", "team", "custom"],
        ] as const)
            await db.insert(recordingFolders).values({
                id,
                userId,
                parentId,
                kind,
                name: encryptText(id),
                nameHash: lookupHash(id),
                restrictedAt: ["readable", "unreadable"].includes(id)
                    ? new Date()
                    : null,
            });
        await db
            .insert(restrictedFolderMembers)
            .values({ folderId: "readable", userId: "viewer" });
        await db.insert(people).values({
            id: "me",
            userId: "viewer",
            displayName: encryptText("Lada Cloudfern"),
            primaryEmailHash: viewer().emailHash,
        });
        await db.insert(folderShares).values({
            id: "invitation",
            folderId: "person-shared",
            userId: "other",
            receiverUserId: "viewer",
            state: "accepted",
        });
        await db.insert(receivedFolderAttachments).values({
            id: "attachment",
            userId: "viewer",
            shareId: "invitation",
            parentId: "parent",
            name: encryptText("Shared plans"),
        });
        for (const [id, userId, folderId, assigned, status, deleted] of [
            ["mine-item", "viewer", "mine", true, "done", false],
            ["followed-item", "viewer", "followed", false, "open", false],
            ["all-item", "other", "all", false, "dropped", false],
            ["restricted-item", "other", "readable", true, "open", false],
            ["hidden-item", "other", "unreadable", true, "open", false],
            ["withheld-item", "other", "withheld", true, "open", false],
            ["person-item", "other", "person-shared", true, "open", false],
            ["person-child-item", "other", "person-child", true, "open", false],
            ["proposal-item", "viewer", "excluded", true, "proposed", false],
            ["deleted-item", "viewer", "excluded", true, "open", true],
        ] as const) {
            await db.insert(chatterItems).values({
                id,
                userId,
                kind: "mail",
                title: encryptText(id),
                occurredAt: new Date(),
                deletedAt: deleted ? new Date() : null,
            });
            await db.insert(recordingTasks).values({
                id: `task-${id}`,
                itemId: id,
                userId,
                text: encryptText("Task"),
                source: "manual",
                status,
                assigneePersonId: assigned ? "me" : null,
            });
            await db.insert(recordingFolderAssignments).values({
                itemId: id,
                folderId,
                userId,
                withheld: ["readable", "unreadable", "withheld"].includes(
                    folderId,
                ),
            });
        }
        await db.insert(recordingFolderAssignments).values({
            itemId: "all-item",
            userId: "other",
            folderId: "unreadable",
            withheld: true,
        });
        await db.insert(recordingTasks).values([
            {
                id: "own-task",
                userId: "viewer",
                itemId: null,
                folderId: "own",
                text: encryptText("Private reminder"),
                source: "personal",
                status: "dropped",
            },
            {
                id: "own-followed-task",
                userId: "viewer",
                itemId: null,
                folderId: "own-followed",
                text: encryptText("Followed reminder"),
                source: "personal",
                status: "open",
            },
            {
                id: "foreign-own-task",
                userId: "other",
                itemId: null,
                folderId: "empty",
                text: encryptText("Foreign reminder"),
                source: "personal",
                status: "open",
            },
        ]);
        await db.insert(taskFollowers).values([
            { taskId: "own-followed-task", userId: "viewer" },
            { taskId: "task-person-item", userId: "viewer" },
            { taskId: "task-restricted-item", userId: "viewer" },
        ]);
        await db.insert(chatterItems).values({
            id: "direct",
            userId: "other",
            kind: "mail",
            title: encryptText("Direct share"),
            occurredAt: new Date(),
        });
        await db.insert(recordingTasks).values({
            id: "direct-task",
            userId: "other",
            itemId: "direct",
            source: "manual",
            status: "open",
            assigneePersonId: "me",
            text: encryptText("Direct task"),
        });
        await db.insert(itemShares).values({
            itemId: "direct",
            userId: "other",
            receiverUserId: "viewer",
            state: "accepted",
            filingFolderId: "filed-share",
        });
    });
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    const ids = async (tab: TaskTab, person = viewer(), organization = false) =>
        (await listTaskFolderIds(person, tab, organization)).sort();
    const list = (
        tab: TaskTab,
        folderId: string | null = null,
        person = viewer(),
    ) =>
        listTasks(person, {
            tab,
            folderId,
            state: "all",
            due: null,
            today: null,
            sort: "created",
        });

    it.each([
        [
            "mine",
            [
                "private",
                "mine",
                "own",
                "own-followed",
                "readable",
                "attachment",
                "filed-share",
            ],
        ],
        ["followed", ["private", "followed", "readable", "attachment"]],
        [
            "all",
            [
                "private",
                "mine",
                "own",
                "own-followed",
                "followed",
                "all",
                "readable",
                "attachment",
                "filed-share",
            ],
        ],
    ] as const)("offers only folders holding %s tasks across accepted states", async (tab, expected) => {
        expect(await ids(tab)).toEqual([...expected].sort());
    });
    it("adds ancestors without unrelated siblings, and retains the selected path across tabs", async () => {
        const tree = await listRecordingFolderTrees("viewer", false);
        const options = taskFilterFolders(
            tree,
            await ids("followed"),
            "mine",
        ).map((folder) => folder.id);
        expect(options.sort()).toEqual(
            [
                "private",
                "parent",
                "team",
                "followed",
                "readable",
                "attachment",
                "mine",
            ].sort(),
        );
        expect(
            taskFilterFolders(tree, await ids("followed")).map(
                (folder) => folder.id,
            ),
        ).not.toContain("mine");
        expect(taskFilterFolders(tree, [], "unreadable")).toEqual([]);
    });
    it("keeps Followed item-folder semantics for explicitly followed own tasks", async () => {
        expect(
            (await list("followed", "own-followed")).map((task) => task.id),
        ).toEqual([]);
        expect((await list("followed")).map((task) => task.id)).toContain(
            "own-followed-task",
        );
    });

    it.each([
        "own",
        "organization-only",
        "direct-share",
    ] as const)("offers only the Private root for an otherwise unfiled %s task", async (kind) => {
        const isolated = await createMigratedTestDatabase(
            url ?? "",
            "task_private_root",
        );
        ref.current = isolated.db as unknown as Record<PropertyKey, unknown>;
        try {
            const userId = `unfiled-${kind}`;
            const rootId = `${userId}-private`;
            const db = isolated.db;
            await db.insert(users).values(
                [userId, "other", "org"].map((id) => ({
                    id,
                    email: `${id}@example.test`,
                    name: "Case viewer",
                    role: id === "org" ? ("org" as const) : ("user" as const),
                })),
            );
            await db.insert(recordingFolders).values([
                {
                    id: rootId,
                    userId,
                    kind: "private",
                    name: encryptText("Private"),
                    nameHash: lookupHash("Private"),
                },
                {
                    id: `${userId}-sibling`,
                    userId,
                    parentId: rootId,
                    kind: "custom",
                    name: encryptText("Unrelated"),
                    nameHash: lookupHash("Unrelated"),
                },
            ]);
            await db.insert(recordingFolders).values([
                {
                    id: "team",
                    userId: "org",
                    kind: "public",
                    name: encryptText("Organization"),
                    nameHash: lookupHash("Organization"),
                },
                {
                    id: "all",
                    userId: "org",
                    parentId: "team",
                    kind: "custom",
                    name: encryptText("Project"),
                    nameHash: lookupHash("Project"),
                },
            ]);
            const person = viewer(userId);
            await db.insert(people).values({
                id: `${userId}-person`,
                userId,
                displayName: encryptText("Case viewer"),
                primaryEmailHash: person.emailHash,
            });
            const itemId = kind === "own" ? null : `${userId}-item`;
            if (itemId)
                await db.insert(chatterItems).values({
                    id: itemId,
                    userId: kind === "direct-share" ? "other" : userId,
                    kind: "mail",
                    title: encryptText("Unfiled source"),
                    occurredAt: new Date(),
                });
            await db.insert(recordingTasks).values({
                id: `${userId}-task`,
                userId: kind === "direct-share" ? "other" : userId,
                itemId,
                source: kind === "own" ? "personal" : "manual",
                status: "open",
                assigneePersonId: kind === "own" ? null : `${userId}-person`,
                text: encryptText("Unfiled task"),
            });
            if (kind === "organization-only" && itemId)
                await db
                    .insert(recordingFolderAssignments)
                    .values({ itemId, userId, folderId: "all" });
            if (kind === "direct-share" && itemId)
                await db.insert(itemShares).values({
                    itemId,
                    userId: "other",
                    receiverUserId: userId,
                    state: "accepted",
                });
            const tree = await listRecordingFolderTrees(userId, false);
            for (const tab of ["mine", "all"] as const) {
                expect(
                    (await list(tab, rootId, person)).map((task) => task.id),
                ).toEqual([`${userId}-task`]);
                const options = taskFilterFolders(
                    tree,
                    await ids(tab, person),
                ).map((entry) => entry.id);
                expect(options).toContain(rootId);
                expect(options).not.toContain(`${userId}-sibling`);
                if (kind !== "organization-only")
                    expect(options).toEqual([rootId]);
            }
            await db
                .insert(taskFollowers)
                .values({ taskId: `${userId}-task`, userId });
            const following = await ids("followed", person);
            expect(following.includes(rootId)).toBe(kind !== "own");
            if (kind === "own") expect(following).toEqual([]);
            if (kind === "direct-share") {
                await db
                    .update(itemShares)
                    .set({ state: "removed" })
                    .where(eq(itemShares.receiverUserId, userId));
                expect(await ids("mine", person)).toEqual([]);
            }
        } finally {
            ref.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
            await isolated.dispose();
        }
    });

    it("keeps state, deadline, assignee and selected folder out of the folder set", async () => {
        const response = await GET(
            new NextRequest(
                "https://example.test/api/tasks?tab=mine&state=open&due=overdue&today=2026-11-11&folder=empty&assignee=none&folders=true",
            ),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.tasks).toEqual([]);
        expect(body.folderIds.sort()).toEqual(await ids("mine"));
    });
    it("does not query options unless requested", async () => {
        const execute = vi.spyOn(database.db, "execute");
        try {
            const response = await GET(
                new NextRequest("https://example.test/api/tasks?tab=mine"),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).not.toHaveProperty("folderIds");
            expect(execute).not.toHaveBeenCalled();
        } finally {
            execute.mockRestore();
        }
    });
    it("uses one query with a result bounded by folders, beyond the 200-task list limit", async () => {
        const db = database.db;
        await db.insert(recordingTasks).values(
            Array.from({ length: 205 }, () => ({
                userId: "viewer",
                itemId: "mine-item",
                assigneePersonId: "me",
                status: "open" as const,
                source: "manual" as const,
                text: encryptText("Recent task"),
                createdAt: new Date(Date.now() + 1000),
            })),
        );
        const execute = vi.spyOn(db, "execute");
        try {
            expect(await ids("mine")).toContain("own");
            expect(execute).toHaveBeenCalledTimes(1);
        } finally {
            execute.mockRestore();
        }
        expect(await list("mine")).toHaveLength(200);
        expect(await ids("mine")).toHaveLength(7);
    });
    it("never exposes hidden placements even when the task is visible elsewhere", async () => {
        expect(
            (await list("all", "all")).some(
                (task) => task.id === "task-all-item",
            ),
        ).toBe(true);
        expect(await ids("all")).not.toContain("unreadable");
        expect(await ids("all")).not.toContain("withheld");
        expect(await ids("all")).not.toContain("person-child");
        expect(await ids("all")).not.toContain("excluded");
        expect(await ids("all")).not.toContain("empty");
    });
    it("honors received capability and current curator visibility", async () => {
        expect(
            await ids("mine", { ...viewer(), includeReceived: false }),
        ).toEqual(["private", "mine", "own", "own-followed"].sort());
        expect(await ids("all", { ...viewer(), isCurator: true })).toContain(
            "unreadable",
        );
        expect(await ids("mine", viewer("org"))).toEqual([]);
        expect(await ids("all", viewer("org"))).toEqual(
            ["all", "readable", "unreadable", "withheld"].sort(),
        );
        expect(
            await ids("followed", { ...viewer(), isCurator: true }, true),
        ).toEqual(["private", "all", "unreadable"].sort());
    });
    it("removes withdrawn follows and revoked invitations without widening visibility", async () => {
        await database.db
            .insert(taskUnfollows)
            .values({ taskId: "task-followed-item", userId: "viewer" });
        expect(await ids("followed")).not.toContain("followed");
        await database.db
            .update(folderShares)
            .set({ state: "removed" })
            .where(eq(folderShares.id, "invitation"));
        expect(await ids("mine")).not.toContain("attachment");
        await database.db
            .delete(restrictedFolderMembers)
            .where(eq(restrictedFolderMembers.userId, "viewer"));
        expect(await ids("mine")).not.toContain("readable");
    });
});
