import { eq } from "drizzle-orm";
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
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    chatterItems,
    folderShares,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    users,
} from "@/db/schema";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { agendaTaskGroupKey } from "@/lib/meetings/task-groups";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const holder = vi.hoisted(() => ({
    database: null as Record<PropertyKey, unknown> | null,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                const value = holder.database?.[key];
                return typeof value === "function"
                    ? value.bind(holder.database)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "mcp-agenda-test",
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        APP_URL: "https://example.com",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
    isOrgAccount: async () => false,
    isOrgScopeVisible: () => true,
    assertOrgScopeWritable: () => {},
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () => false,
    userCuratesOrganizationNow: async () => false,
}));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const principal = (userId: string): McpCaller => ({
    kind: "user",
    userId,
    email: `${userId}@example.com`,
    subject: userId,
    clientId: "test",
    orgUserId: "org",
    roles: new Set(["tasks:read", "tasks:write", "mail:read"]),
});
const groupKey = agendaTaskGroupKey(null);
const operations = [
    { action: "add_point", text: "New" },
    { action: "update_point", pointId: "point", version: 0, discussed: true },
    { action: "remove_point", pointId: "point", version: 0 },
    { action: "add_task", taskId: "one" },
    { action: "remove_task", taskId: "one" },
    { action: "reorder_tasks", groupKey, taskIds: ["two", "one"] },
    { action: "set_task_note", taskId: "one", note: "Review" },
    { action: "restore_task", taskId: "one" },
    { action: "add_suggestion", suggestionId: "ai" },
    { action: "dismiss_suggestion", suggestionId: "ai" },
    { action: "dismiss_suggestions", kind: "carry_over" },
];
const writeCases = [
    ...operations.map((operation) => ({
        name: "edit_agenda",
        input: { operations: [operation] },
    })),
    { name: "update_agenda", input: { title: "Changed", version: 0 } },
    { name: "suggest_agenda_points", input: { locale: "cs-CZ" } },
];
async function run(
    name: string,
    input: Record<string, unknown>,
    caller = principal("owner"),
) {
    const tool = MEETING_TOOLS.find((entry) => entry.name === name);
    if (!tool) throw new Error("Tool missing");
    return tool.run(
        { caller, touched: [] },
        z.object(tool.input(caller)).parse({ meetingId: "agenda", ...input }),
    );
}
const url = getTestDatabaseUrl();
describe.skipIf(!url)("agenda MCP service boundaries (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "mcp_agenda");
        holder.database = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120000);
    afterAll(async () => {
        holder.database = null;
        await database?.dispose();
    }, 60000);
    beforeEach(async () => {
        const db = database.db;
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "editor", "stranger"].map((id) => ({
                id,
                email: `${id}@example.com`,
            })),
        );
        await db.insert(recordingFolders).values({
            id: "folder",
            userId: "owner",
            kind: "custom",
            name: encryptText("Acme"),
            nameHash: lookupHash("Acme"),
        });
        await db.insert(chatterItems).values([
            {
                id: "meeting",
                userId: "owner",
                kind: "meeting",
                occurredAt: new Date(),
                title: encryptText("Planning"),
            },
            {
                id: "source",
                userId: "owner",
                kind: "audio",
                occurredAt: new Date(),
                title: encryptText("Previous meeting"),
            },
        ]);
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
        });
        await db.insert(recordingFolderAssignments).values(
            ["meeting", "source"].map((itemId) => ({
                userId: "owner",
                itemId,
                folderId: "folder",
            })),
        );
        await db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "editor",
            folderId: "folder",
            state: "accepted",
        });
        await db.insert(recordingTasks).values(
            ["one", "two"].map((id) => ({
                id,
                userId: "owner",
                itemId: "source",
                status: "open" as const,
                source: "manual" as const,
                text: encryptText(id),
            })),
        );
        await db.insert(agendaTasks).values(
            ["one", "two"].map((taskId, position) => ({
                taskId,
                userId: "owner",
                agendaId: "agenda",
                origin: "older" as const,
                position,
            })),
        );
        await db.insert(agendaPoints).values({
            id: "point",
            userId: "owner",
            agendaId: "agenda",
            text: encryptText("Original"),
            authorUserId: "owner",
            position: 0,
        });
        await db.insert(agendaSuggestions).values(
            ["ai", "carry_over"].map((kind) => ({
                id: kind,
                kind: kind as "ai" | "carry_over",
                userId: "owner",
                agendaId: "agenda",
                text: encryptText(`Proposed ${kind}`),
                sources: { itemIds: [], taskIds: [] },
            })),
        );
    });

    it("persists task order, agenda notes, removal and restore without changing real tasks", async () => {
        const result = await run("edit_agenda", {
            operations: [
                { action: "reorder_tasks", groupKey, taskIds: ["two", "one"] },
                { action: "set_task_note", taskId: "one", note: "Review" },
                { action: "remove_task", taskId: "two" },
                { action: "restore_task", taskId: "two" },
            ],
        });
        expect(result).toMatchObject({
            completed: 4,
            meeting: {
                taskGroups: [
                    {
                        key: groupKey,
                        tasks: [
                            { id: "two" },
                            { id: "one", agendaNote: "Review" },
                        ],
                    },
                ],
            },
        });
        const [link] = await database.db
            .select()
            .from(agendaTasks)
            .where(eq(agendaTasks.taskId, "one"));
        expect(link.note).not.toContain("Review");
        expect(decryptText(link.note)).toBe("Review");
        await run("edit_agenda", {
            operations: [
                { action: "set_task_note", taskId: "one", note: null },
            ],
        });
        expect(await database.db.select().from(recordingTasks)).toMatchObject([
            { status: "open", note: null },
            { status: "open", note: null },
        ]);
    });

    async function addMailTask() {
        await database.db.insert(chatterItems).values({
            id: "mail-source",
            userId: "owner",
            kind: "mail",
            occurredAt: new Date(),
            title: encryptText("Mail"),
        });
        await database.db.insert(recordingFolderAssignments).values({
            userId: "owner",
            itemId: "mail-source",
            folderId: "folder",
        });
        await database.db.insert(recordingTasks).values({
            id: "hidden-task",
            userId: "owner",
            itemId: "mail-source",
            status: "open",
            source: "manual",
            text: encryptText("Mail task"),
        });
        await database.db
            .update(agendaTasks)
            .set({ position: 2 })
            .where(eq(agendaTasks.taskId, "two"));
        await database.db.insert(agendaTasks).values({
            taskId: "hidden-task",
            userId: "owner",
            agendaId: "agenda",
            origin: "older",
            position: 1,
        });
    }

    it.each([
        false,
        true,
    ])("reorders exactly the visible tasks with mail:read=%s", async (mailAllowed) => {
        await addMailTask();
        const caller = principal("owner");
        if (!mailAllowed) caller.roles.delete("mail:read");
        const taskIds = mailAllowed
            ? ["hidden-task", "two", "one"]
            : ["two", "one"];
        expect(await run("get_meeting", {}, caller)).toMatchObject({
            meeting: {
                taskGroups: [
                    {
                        key: groupKey,
                        tasks: mailAllowed
                            ? [
                                  { id: "one" },
                                  { id: "hidden-task" },
                                  { id: "two" },
                              ]
                            : [{ id: "one" }, { id: "two" }],
                    },
                ],
            },
        });
        await run(
            "edit_agenda",
            {
                operations: [{ action: "reorder_tasks", groupKey, taskIds }],
            },
            caller,
        );
        expect(
            (
                await database.db
                    .select()
                    .from(agendaTasks)
                    .orderBy(agendaTasks.position)
            ).map((task) => task.taskId),
        ).toEqual(mailAllowed ? taskIds : ["two", "hidden-task", "one"]);
        for (const invalid of [["one"], ["two", "unknown"]]) {
            const error = await run(
                "edit_agenda",
                {
                    operations: [
                        { action: "reorder_tasks", groupKey, taskIds: invalid },
                    ],
                },
                caller,
            ).catch((error: unknown) => error);
            expect(error).toMatchObject({
                outcome: "conflict",
                details: { completed: 0 },
            });
            expect(JSON.stringify(error)).not.toContain("hidden-task");
        }
    });

    it.each([
        false,
        true,
    ])("reorders visible groups and compares the projected previous order with mail:read=%s", async (mailAllowed) => {
        await addMailTask();
        for (const [taskId, name] of [
            ["one", "Alpha"],
            ["hidden-task", "Hidden group"],
            ["two", "Beta"],
        ])
            await database.db
                .update(recordingTasks)
                .set({ assigneeHint: encryptText(name) })
                .where(eq(recordingTasks.id, taskId));
        const fullOrder = ["alpha", "hidden group", "beta"];
        await database.db
            .update(meetingAgendas)
            .set({ taskGroupOrder: encryptJsonField(fullOrder) });
        const caller = principal("editor");
        if (!mailAllowed) caller.roles.delete("mail:read");
        const previous = mailAllowed ? fullOrder : ["alpha", "beta"];
        const requested = mailAllowed
            ? ["hidden group", "beta", "alpha"]
            : ["beta", "alpha"];
        expect(await run("get_meeting", {}, caller)).toMatchObject({
            meeting: { taskGroupOrder: previous },
        });
        await run(
            "update_agenda",
            {
                taskGroupOrder: requested,
                version: 0,
                previous: { taskGroupOrder: previous },
            },
            caller,
        );
        expect(await run("get_meeting", {})).toMatchObject({
            meeting: {
                version: 1,
                taskGroupOrder: mailAllowed
                    ? requested
                    : ["beta", "hidden group", "alpha"],
            },
        });
        await expect(
            run(
                "update_agenda",
                {
                    taskGroupOrder: previous,
                    previous: { taskGroupOrder: previous },
                },
                caller,
            ),
        ).rejects.toMatchObject({
            outcome: "conflict",
            details: { version: 1 },
        });
        for (const invalid of [["alpha"], ["beta", "unknown"]]) {
            const error = await run(
                "update_agenda",
                {
                    taskGroupOrder: invalid,
                    previous: { taskGroupOrder: requested },
                },
                caller,
            ).catch((error: unknown) => error);
            expect(error).toMatchObject({ outcome: "conflict" });
            expect(JSON.stringify(error)).not.toContain("hidden group");
        }
        expect(await run("get_meeting", {}, caller)).toMatchObject({
            meeting: { version: 1, taskGroupOrder: requested },
        });
    });

    it("accepts an empty projected previous order while retaining a stored hidden-only group", async () => {
        await addMailTask();
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Hidden group") })
            .where(eq(recordingTasks.id, "hidden-task"));
        await database.db
            .update(meetingAgendas)
            .set({ taskGroupOrder: encryptJsonField(["hidden group"]) });
        const caller = principal("owner");
        caller.roles.delete("mail:read");
        expect(await run("get_meeting", {}, caller)).toMatchObject({
            meeting: { taskGroupOrder: [] },
        });
        await run(
            "update_agenda",
            { taskGroupOrder: [groupKey], previous: { taskGroupOrder: [] } },
            caller,
        );
        expect(await run("get_meeting", {})).toMatchObject({
            meeting: { version: 1, taskGroupOrder: ["hidden group", groupKey] },
        });
    });

    it("preserves sub-points on merge-up removal and otherwise deletes the subtree", async () => {
        await database.db.insert(agendaPoints).values({
            id: "child",
            userId: "owner",
            agendaId: "agenda",
            text: encryptText("Child"),
            authorUserId: "owner",
            parentId: "point",
            position: 1,
        });
        await run("edit_agenda", {
            operations: [
                {
                    action: "remove_point",
                    pointId: "point",
                    version: 0,
                    mergeUp: true,
                },
            ],
        });
        expect(await database.db.select().from(agendaPoints)).toMatchObject([
            { id: "child", parentId: null, version: 1 },
        ]);
        await database.db.insert(agendaPoints).values({
            id: "nested",
            userId: "owner",
            agendaId: "agenda",
            text: encryptText("Nested"),
            authorUserId: "owner",
            parentId: "child",
            position: 2,
        });
        await run("edit_agenda", {
            operations: [
                { action: "remove_point", pointId: "child", version: 1 },
            ],
        });
        expect(await database.db.select().from(agendaPoints)).toEqual([]);
    });
    it("accepts and dismisses suggestions through the shared service", async () => {
        await run("edit_agenda", {
            operations: [
                { action: "add_suggestion", suggestionId: "ai" },
                { action: "add_suggestion", suggestionId: "ai" },
                { action: "dismiss_suggestion", suggestionId: "carry_over" },
            ],
        });
        expect(await database.db.select().from(agendaPoints)).toHaveLength(2);
        expect(
            await database.db
                .select()
                .from(agendaSuggestions)
                .orderBy(agendaSuggestions.id),
        ).toMatchObject([
            { id: "ai", state: "added" },
            { id: "carry_over", state: "dismissed" },
        ]);
        await database.db.update(agendaSuggestions).set({ state: "open" });
        await run("edit_agenda", {
            operations: [{ action: "dismiss_suggestions", kind: "ai" }],
        });
        expect(
            await database.db
                .select()
                .from(agendaSuggestions)
                .orderBy(agendaSuggestions.id),
        ).toMatchObject([{ state: "dismissed" }, { state: "open" }]);
    });
    it("keeps earlier batch edits and reports stale point versions", async () => {
        await expect(
            run("edit_agenda", {
                operations: [
                    {
                        action: "update_point",
                        pointId: "point",
                        version: 0,
                        discussed: true,
                    },
                    {
                        action: "update_point",
                        pointId: "point",
                        version: 0,
                        note: "Stale",
                    },
                ],
            }),
        ).rejects.toMatchObject({
            outcome: "conflict",
            details: { completed: 1 },
        });
        expect(await database.db.select().from(agendaPoints)).toMatchObject([
            { version: 1, discussedAt: expect.any(Date), note: null },
        ]);
    });
    it("uses meeting version and previous values exactly as the web patch does", async () => {
        await run("update_agenda", { title: "Renamed", version: 0 });
        await expect(
            run("update_agenda", { title: "Stale", version: 0 }),
        ).rejects.toMatchObject({
            outcome: "conflict",
            details: { version: 1 },
        });
        await run("update_agenda", {
            title: "Compared",
            version: 0,
            previous: { title: "Renamed" },
        });
        await expect(
            run("update_agenda", {
                title: "Stale",
                previous: { title: "Renamed" },
            }),
        ).rejects.toMatchObject({ outcome: "conflict" });
        expect(await run("get_meeting", {})).toMatchObject({
            meeting: { title: "Compared", version: 2 },
        });
    });
    it("lets a co-editor reorder groups and tasks but reserves agenda fields and others' point text for the author", async () => {
        const editor = principal("editor");
        await run(
            "update_agenda",
            { taskGroupOrder: [groupKey], previous: { taskGroupOrder: [] } },
            editor,
        );
        await run(
            "edit_agenda",
            {
                operations: [
                    {
                        action: "reorder_tasks",
                        groupKey,
                        taskIds: ["two", "one"],
                    },
                ],
            },
            editor,
        );
        await expect(
            run("update_agenda", { title: "Denied" }, editor),
        ).rejects.toMatchObject({ outcome: "denied" });
        await expect(
            run(
                "edit_agenda",
                {
                    operations: [
                        {
                            action: "update_point",
                            pointId: "point",
                            version: 0,
                            text: "Denied",
                        },
                    ],
                },
                editor,
            ),
        ).rejects.toMatchObject({ outcome: "denied" });
        await run("update_agenda", { title: "Author edit" });
        await run("edit_agenda", {
            operations: [
                {
                    action: "update_point",
                    pointId: "point",
                    version: 0,
                    text: "Author edit",
                },
            ],
        });
    });
    it.each(
        writeCases,
    )("refuses stranger writes through $name ($input)", async ({
        name,
        input,
    }) => {
        await expect(
            run(name, input, principal("stranger")),
        ).rejects.toMatchObject({ outcome: "not_found" });
        expect(await database.db.select().from(meetingAgendas)).toMatchObject([
            { version: 0 },
        ]);
    });
    it.each(
        writeCases,
    )("refuses absorbed agenda writes through $name ($input)", async ({
        name,
        input,
    }) => {
        await database.db
            .update(meetingAgendas)
            .set({ recordingItemId: "source", absorbedAt: new Date() });
        await expect(run(name, input)).rejects.toMatchObject({
            outcome: "conflict",
        });
        expect(await database.db.select().from(meetingAgendas)).toMatchObject([
            { version: 0 },
        ]);
    });
});
