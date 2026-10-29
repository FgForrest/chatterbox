import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tasks/route";
import {
    chatterItems,
    itemShares,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { TaskViewer } from "@/lib/tasks/access";
import {
    listTasks,
    listTrackedAssignees,
    type TaskListItem,
    type TaskTab,
} from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref, proxy, identity } = vi.hoisted(() => {
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
        identity: { userId: "viewer" },
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
        BETTER_AUTH_SECRET: "folder-tasks-test",
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
    requireTaskViewer: async () => viewer(identity.userId),
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
describe.skipIf(!url)("folder tasks across all visible sources", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "folder_tasks");
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
            ["folder", "viewer", "private", "custom"],
            ["child", "viewer", "folder", "custom"],
            ["sibling", "viewer", "private", "custom"],
            ["other-private", "other", null, "private"],
            ["team", "org", null, "public"],
            ["team-child", "org", "team", "custom"],
        ] as const)
            await db.insert(recordingFolders).values({
                id,
                userId,
                parentId,
                kind,
                name: encryptText(id),
                nameHash: lookupHash(id),
            });
        await db.insert(people).values({
            id: "assignee",
            userId: "org",
            displayName: encryptText("Lada Cloudfern"),
            primaryEmailHash: lookupHash("lada@example.test"),
        });
        for (const [id, userId] of [
            ["owned", "viewer"],
            ["shared-owned", "viewer"],
            ["shared-other", "other"],
            ["received", "other"],
            ["hidden", "other"],
            ["sibling-item", "viewer"],
        ] as const) {
            await db.insert(chatterItems).values({
                id,
                userId,
                kind: "mail",
                title: encryptText(id),
                occurredAt: new Date("2026-10-28T10:00:00Z"),
            });
            await db.insert(recordingTasks).values({
                id: `task-${id}`,
                itemId: id,
                userId,
                text: encryptText(`Task ${id}`),
                status: "open",
                source: "manual",
                assigneePersonId: id.startsWith("shared") ? "assignee" : null,
            });
        }
        await db.insert(recordingTasks).values([
            {
                id: "own",
                userId: "viewer",
                itemId: null,
                folderId: "folder",
                source: "personal",
                status: "open",
                text: encryptText("Own task"),
            },
            {
                id: "own-child",
                userId: "viewer",
                itemId: null,
                folderId: "child",
                source: "personal",
                status: "open",
                text: encryptText("Own child task"),
            },
            {
                id: "own-sibling",
                userId: "viewer",
                itemId: null,
                folderId: "sibling",
                source: "personal",
                status: "open",
                text: encryptText("Sibling task"),
            },
            {
                id: "other-own",
                userId: "other",
                itemId: null,
                source: "personal",
                status: "open",
                text: encryptText("Other own task"),
            },
            {
                id: "proposed",
                userId: "viewer",
                itemId: "owned",
                source: "manual",
                status: "proposed",
                text: encryptText("Proposal"),
            },
        ]);
        await db.insert(recordingFolderAssignments).values([
            { itemId: "owned", folderId: "folder", userId: "viewer" },
            { itemId: "shared-owned", folderId: "child", userId: "viewer" },
            { itemId: "shared-owned", folderId: "team-child", userId: "org" },
            { itemId: "shared-other", folderId: "team-child", userId: "org" },
            { itemId: "hidden", folderId: "folder", userId: "other" },
            { itemId: "sibling-item", folderId: "sibling", userId: "viewer" },
        ]);
        await db.insert(itemShares).values({
            userId: "other",
            receiverUserId: "viewer",
            itemId: "received",
            state: "accepted",
            filingFolderId: "folder",
        });
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    const list = (
        tab: TaskTab,
        folderId: string | null,
        userId = "viewer",
        assignee?: string,
    ) =>
        listTasks(viewer(userId), {
            tab,
            folderId,
            state: "open",
            sort: "created",
            due: null,
            today: null,
            assignee,
        });
    const ids = (tasks: TaskListItem[]) => tasks.map((task) => task.id).sort();

    it("GET tab=all includes own tasks in descendants and every visible item source", async () => {
        identity.userId = "viewer";
        const response = await GET(
            new NextRequest(
                "https://example.test/api/tasks?tab=all&folder=folder",
            ),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { tasks: TaskListItem[] };
        expect(ids(body.tasks)).toEqual(
            [
                "own",
                "own-child",
                "task-owned",
                "task-received",
                "task-shared-owned",
            ].sort(),
        );
    });
    it("keeps Mine and Followed narrowing and unknown-tab fallback", async () => {
        expect(ids(await list("mine", "folder"))).toEqual(["own", "own-child"]);
        expect(ids(await list("followed", "folder"))).toEqual([
            "task-owned",
            "task-shared-owned",
        ]);
        identity.userId = "viewer";
        const response = await GET(
            new NextRequest(
                "https://example.test/api/tasks?tab=unknown&folder=folder",
            ),
        );
        expect(
            ids(((await response.json()) as { tasks: TaskListItem[] }).tasks),
        ).toEqual(["own", "own-child"]);
    });
    it("includes unfollowed Organization tasks and applies All's assignee filter", async () => {
        expect(ids(await list("all", "team"))).toEqual([
            "task-shared-other",
            "task-shared-owned",
        ]);
        expect(ids(await list("followed", "team"))).toEqual([
            "task-shared-owned",
        ]);
        expect(ids(await list("all", "folder", "viewer", "assignee"))).toEqual([
            "task-shared-owned",
        ]);
        expect(ids(await list("all", "folder", "viewer", "none"))).toEqual(
            ["own", "own-child", "task-owned", "task-received"].sort(),
        );
        expect(await listTrackedAssignees(viewer(), false, "all")).toEqual([
            { personId: "assignee", name: "Lada Cloudfern" },
        ]);
    });
    it("keeps Organization Mine empty, allows All, and never exposes personal tasks", async () => {
        expect(await list("mine", "team", "org")).toEqual([]);
        expect(ids(await list("all", "team", "org"))).toEqual([
            "task-shared-other",
            "task-shared-owned",
        ]);
        expect(ids(await list("all", null, "org"))).toEqual([
            "task-shared-other",
            "task-shared-owned",
        ]);
    });
    it("excludes inaccessible folders and hides received tasks when capability is absent", async () => {
        expect(await list("all", "other-private")).toEqual([]);
        const tasks = await listTasks(
            { ...viewer(), includeReceived: false },
            {
                tab: "all",
                folderId: "folder",
                state: "open",
                sort: "created",
                due: null,
                today: null,
            },
        );
        expect(ids(tasks)).toEqual(
            ["own", "own-child", "task-owned", "task-shared-owned"].sort(),
        );
    });
});
