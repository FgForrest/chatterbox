import { asc, eq, inArray } from "drizzle-orm";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    agendaPoints,
    agendaTasks,
    chatterItems,
    folderShares,
    meetingAgendas,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskMentions,
    users,
} from "@/db/schema";
import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import * as taskQueries from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const holder = vi.hoisted(() => ({
    database: null as Record<PropertyKey, unknown> | null,
    caller: "owner",
    forbidGlobalInTransaction: false,
    inTransaction: false,
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                if (holder.forbidGlobalInTransaction && holder.inTransaction)
                    throw new Error("Global DB accessed inside transaction");
                const value = holder.database?.[key];
                if (
                    key === "transaction" &&
                    holder.forbidGlobalInTransaction &&
                    typeof value === "function"
                )
                    return (run: (tx: unknown) => Promise<unknown>) =>
                        value.call(holder.database, async (tx: unknown) => {
                            holder.inTransaction = true;
                            try {
                                return await run(tx);
                            } finally {
                                holder.inTransaction = false;
                            }
                        });
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
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        BETTER_AUTH_SECRET: "meeting-batch-test",
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
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: holder.caller } }),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: async () => ({
        authn: { user: { id: holder.caller } },
    }),
}));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { PATCH as patchAgenda } from "@/app/api/meetings/[id]/route";
import { PATCH as reorderTasks } from "@/app/api/meetings/[id]/tasks/route";
import { GET as recorderDetail } from "@/app/api/v1/recorder/agendas/[id]/route";
import { collectArchivedMeetings } from "@/lib/export/meetings";
import type { McpRole } from "@/lib/mcp/roles";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";
import { OLDER_TASK_POSITION_BASE } from "@/lib/meetings/positions";
import { restoreMeetings } from "@/lib/meetings/restore";
import {
    addAgendaTasks,
    addPoint,
    changePoint,
    getMeeting,
    patchMeeting,
    refreshMeetingFolderContext,
    reorderAgendaTasks,
} from "@/lib/meetings/service";
import { agendaTaskGroupKey } from "@/lib/meetings/task-groups";

const url = getTestDatabaseUrl();
describe.skipIf(!url)("agenda ordering (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(url ?? "", "agenda_order");
        holder.database = database.db as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120000);
    afterAll(async () => {
        holder.database = null;
        await database?.dispose();
    }, 60000);
    afterEach(() => {
        vi.restoreAllMocks();
        holder.forbidGlobalInTransaction = false;
        holder.inTransaction = false;
    });
    beforeEach(async () => {
        holder.caller = "owner";
        const db = database.db;
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "stranger"].map((id) => ({
                id,
                email: `${id}@example.com`,
            })),
        );
        await db.insert(recordingFolders).values({
            id: "root",
            userId: "owner",
            kind: "private",
            name: encryptText("Private"),
            nameHash: lookupHash("Private"),
        });
        await db.insert(recordingFolders).values(
            ["first", "second", "outside"].map((id) => ({
                id,
                parentId: "root",
                userId: "owner",
                name: encryptText(id),
                nameHash: lookupHash(id),
            })),
        );
        await db.insert(chatterItems).values(
            [
                { id: "meeting", userId: "owner", kind: "meeting" as const },
                { id: "source", userId: "owner", kind: "audio" as const },
                { id: "other-source", userId: "owner", kind: "audio" as const },
                {
                    id: "private-source",
                    userId: "stranger",
                    kind: "audio" as const,
                },
                {
                    id: "outside-source",
                    userId: "owner",
                    kind: "audio" as const,
                },
            ].map((row) => ({
                ...row,
                title: encryptText("Planning"),
                occurredAt: new Date(),
            })),
        );
        await db.insert(meetingAgendas).values({
            id: "agenda",
            userId: "owner",
            meetingItemId: "meeting",
        });
        await db.insert(recordingFolderAssignments).values([
            { itemId: "meeting", folderId: "first", userId: "owner" },
            { itemId: "meeting", folderId: "second", userId: "owner" },
            { itemId: "source", folderId: "first", userId: "owner" },
            { itemId: "other-source", folderId: "second", userId: "owner" },
            { itemId: "outside-source", folderId: "outside", userId: "owner" },
        ]);
        await db.insert(recordingTasks).values(
            [
                { id: "existing", itemId: "source", userId: "owner" },
                { id: "one", itemId: "source", userId: "owner" },
                { id: "two", itemId: "other-source", userId: "owner" },
                { id: "three", itemId: "source", userId: "owner" },
                {
                    id: "invisible",
                    itemId: "private-source",
                    userId: "stranger",
                },
                { id: "outside", itemId: "outside-source", userId: "owner" },
            ].map((row) => ({
                ...row,
                status: "open" as const,
                createdByUserId: row.userId,
                source: "manual" as const,
                text: encryptText("Follow up"),
            })),
        );
        await db.insert(agendaTasks).values({
            agendaId: "agenda",
            userId: "owner",
            taskId: "existing",
            origin: "last_meeting",
            position: 7,
        });
    });
    const links = () =>
        database.db
            .select()
            .from(agendaTasks)
            .orderBy(asc(agendaTasks.position));
    async function version() {
        const [row] = await database.db
            .select()
            .from(meetingAgendas)
            .where(eq(meetingAgendas.id, "agenda"));
        return row.version;
    }

    const call = (handler: typeof reorderTasks, body: unknown) =>
        handler(
            new Request("https://example.com/api/meetings/agenda/tasks", {
                method: "PATCH",
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id: "agenda" }) },
        );
    const groupKey = agendaTaskGroupKey(null);
    it("stores group keys encrypted and refuses a stale previous value", async () => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Jitka Dvořáková") })
            .where(eq(recordingTasks.id, "one"));
        const taskGroupOrder = [groupKey, "jitka dvořáková"];
        expect(
            (
                await call(patchAgenda, {
                    taskGroupOrder,
                    previous: { taskGroupOrder: [] },
                })
            ).status,
        ).toBe(200);
        const [stored] = await database.db.select().from(meetingAgendas);
        expect(stored.taskGroupOrder).toHaveProperty("c");
        expect(JSON.stringify(stored.taskGroupOrder)).not.toContain("jitka");
        expect(decryptJsonField(stored.taskGroupOrder)).toEqual(taskGroupOrder);
        expect(
            (
                await call(patchAgenda, {
                    taskGroupOrder: [],
                    previous: { taskGroupOrder: [] },
                })
            ).status,
        ).toBe(409);
        expect(await version()).toBe(2);
    });
    it.each([
        { taskGroupOrder: ["x"] },
        { taskGroupOrder: ["x", "x"], previous: { taskGroupOrder: [] } },
        {
            taskGroupOrder: ["x".repeat(2001)],
            previous: { taskGroupOrder: [] },
        },
        {
            taskGroupOrder: Array.from({ length: 501 }, (_, i) => String(i)),
            previous: { taskGroupOrder: [] },
        },
    ])("validates bounded complete group order input %j", async (body) => {
        expect((await call(patchAgenda, body)).status).toBe(400);
        expect(await version()).toBe(0);
    });
    it("keeps the archive bound when hidden keys and new visible groups exceed it", async () => {
        const hidden = Array.from(
            { length: 500 },
            (_, index) => `hidden-${index}`,
        );
        await database.db
            .update(meetingAgendas)
            .set({ taskGroupOrder: encryptJsonField(hidden) });
        expect(
            (
                await call(patchAgenda, {
                    taskGroupOrder: [groupKey],
                    previous: { taskGroupOrder: [] },
                })
            ).status,
        ).toBe(400);
        const [stored] = await database.db.select().from(meetingAgendas);
        expect(decryptJsonField(stored.taskGroupOrder)).toEqual(hidden);
        expect(await version()).toBe(0);
    });
    it("reassigns one group's existing positions and preserves every attribution field", async () => {
        await addAgendaTasks("owner", "agenda", ["one", "two"]);
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Martin Král") })
            .where(eq(recordingTasks.id, "two"));
        await database.db.update(agendaTasks).set({
            updatedByUserId: "owner",
            version: 4,
            note: encryptText("Keep note"),
        });
        const before = await links();
        expect(
            (
                await call(reorderTasks, {
                    groupKey,
                    taskIds: ["one", "existing"],
                })
            ).status,
        ).toBe(200);
        const after = await links();
        expect(after.map((task) => [task.taskId, task.position])).toEqual([
            ["one", 7],
            ["existing", 100000],
            ["two", 100001],
        ]);
        for (const task of after)
            expect(task).toEqual({
                ...before.find((row) => row.taskId === task.taskId),
                position: task.position,
            });
        expect(await version()).toBe(2);
    });
    it("can reorder legacy equal position slots", async () => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db.update(agendaTasks).set({ position: 7 });
        await reorderAgendaTasks("owner", "agenda", {
            groupKey,
            taskIds: ["one", "existing"],
        });
        expect(
            (await links()).map((task) => [task.taskId, task.position]),
        ).toEqual([
            ["one", 7],
            ["existing", 8],
        ]);
    });
    it.each([
        { taskIds: ["existing"] },
        { taskIds: ["one", "two"] },
        { taskIds: ["existing", "one", "two"] },
        { taskIds: ["existing", "existing"] },
    ])("refuses mismatched or cross-group task ids %j", async ({ taskIds }) => {
        await addAgendaTasks("owner", "agenda", ["one", "two"]);
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Martin Král") })
            .where(eq(recordingTasks.id, "two"));
        const before = await links();
        expect((await call(reorderTasks, { groupKey, taskIds })).status).toBe(
            new Set(taskIds).size === taskIds.length ? 409 : 400,
        );
        expect(await links()).toEqual(before);
    });
    it("permits shared agenda editors to reorder during a live meeting", async () => {
        await database.db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "stranger",
            folderId: "first",
            state: "accepted",
        });
        await addAgendaTasks("owner", "agenda", ["one"]);
        await patchMeeting("owner", "agenda", { state: "live" });
        holder.caller = "stranger";
        expect(
            (
                await call(patchAgenda, {
                    taskGroupOrder: [groupKey],
                    previous: { taskGroupOrder: [] },
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await call(reorderTasks, {
                    groupKey,
                    taskIds: ["one", "existing"],
                })
            ).status,
        ).toBe(200);
        expect((await links()).map((task) => task.taskId)).toEqual([
            "one",
            "existing",
        ]);
    });
    it("refuses another user and absorbed agendas", async () => {
        holder.caller = "stranger";
        for (const [handler, body] of [
            [
                patchAgenda,
                { taskGroupOrder: [], previous: { taskGroupOrder: [] } },
            ],
            [reorderTasks, { groupKey, taskIds: ["existing"] }],
        ] as const)
            expect((await call(handler, body)).status).toBe(404);
        holder.caller = "owner";
        await database.db
            .update(meetingAgendas)
            .set({ recordingItemId: "source" });
        expect(
            (await call(reorderTasks, { groupKey, taskIds: ["existing"] }))
                .status,
        ).toBe(409);
    });
    it("keeps hand-set mixed source/older order across a re-snapshot and appends new source tasks", async () => {
        await patchMeeting("owner", "agenda", {
            taskSourceItemId: "source",
            previous: { taskSourceItemId: null, noTaskSource: false },
        });
        await addAgendaTasks("owner", "agenda", ["two"]);
        await reorderAgendaTasks("owner", "agenda", {
            groupKey,
            taskIds: ["three", "two", "one", "existing"],
        });
        const before = await links();
        await database.db.insert(recordingTasks).values({
            id: "new",
            itemId: "other-source",
            userId: "owner",
            status: "open",
            source: "manual",
            text: encryptText("New task"),
        });
        await database.db.insert(taskMentions).values(
            ["existing", "one", "three"].map((taskId) => ({
                taskId,
                itemId: "other-source",
                userId: "owner",
                view: "private" as const,
                statementAt: new Date(),
                matchDecision: "accepted" as const,
            })),
        );
        await patchMeeting("owner", "agenda", {
            taskSourceItemId: "other-source",
            previous: { taskSourceItemId: "source", noTaskSource: false },
        });
        const after = await links();
        expect(after.slice(0, 4)).toEqual(before);
        expect(after[4].taskId).toBe("new");
        expect(after[4].position).toBeGreaterThan(before[3].position);
    });
    it("preserves mixed order on automatic folder refresh and appends new source tasks", async () => {
        await database.db.insert(recordings).values({
            id: "source",
            userId: "owner",
            deviceSn: "test",
            plaudFileId: "source",
            duration: 60000,
            endTime: new Date(),
            filesize: 1,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: "test.ogg",
            plaudVersion: "1",
        });
        await refreshMeetingFolderContext("owner", "meeting");
        await addAgendaTasks("owner", "agenda", ["two"]);
        await reorderAgendaTasks("owner", "agenda", {
            groupKey,
            taskIds: ["three", "two", "existing", "one"],
        });
        const before = await links();
        await database.db.insert(recordingTasks).values({
            id: "fresh",
            itemId: "source",
            userId: "owner",
            createdByUserId: "owner",
            status: "open",
            source: "manual",
            text: encryptText("Fresh task"),
        });
        await refreshMeetingFolderContext("owner", "meeting");
        const after = await links();
        expect(after.slice(0, 4)).toEqual(before);
        expect(after[4].taskId).toBe("fresh");
        expect(after[4].position).toBeGreaterThan(before[3].position);
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            taskSource: { id: "source", automatic: true },
        });
    });
    it.each([
        "source",
        "refresh",
        "older",
    ])("compacts restored int4 positions before a %s append and keeps reordering and older additions working", async (append) => {
        await addAgendaTasks("owner", "agenda", ["one", "two"]);
        for (const [index, taskId] of ["two", "existing", "one"].entries())
            await database.db
                .update(agendaTasks)
                .set({ position: 2147483645 + index })
                .where(eq(agendaTasks.taskId, taskId));
        await database.db.insert(recordingTasks).values({
            id: "later",
            userId: "owner",
            itemId: "other-source",
            status: "open",
            source: "manual",
            text: encryptText("Later task"),
        });
        await database.db.insert(meetingAgendas).values({
            id: "other-agenda",
            userId: "owner",
        });
        await database.db.insert(agendaTasks).values({
            agendaId: "other-agenda",
            userId: "owner",
            taskId: "existing",
            position: 2147483647,
            origin: "older",
        });
        const before = (await links()).filter(
            (link) => link.agendaId === "agenda",
        );
        if (append === "refresh") {
            await database.db.insert(recordings).values({
                id: "source",
                userId: "owner",
                deviceSn: "test",
                plaudFileId: "source",
                duration: 60000,
                endTime: new Date(),
                filesize: 1,
                fileMd5: "a".repeat(32),
                storageType: "local",
                storagePath: "test.ogg",
                plaudVersion: "1",
            });
            await refreshMeetingFolderContext("owner", "meeting");
        } else if (append === "source") {
            await patchMeeting("owner", "agenda", {
                taskSourceItemId: "source",
                previous: { taskSourceItemId: null, noTaskSource: false },
            });
        } else await addAgendaTasks("owner", "agenda", ["three"]);
        const compacted = (await links()).filter(
            (link) => link.agendaId === "agenda",
        );
        expect(compacted.slice(0, 3)).toEqual(
            before.map((link, position) => ({ ...link, position })),
        );
        expect(compacted[3]).toMatchObject({ taskId: "three" });
        expect(compacted[3].position).toBeGreaterThan(2);
        expect(compacted[3].position).toBeLessThan(2147483647);
        expect(
            (await links()).find((link) => link.agendaId === "other-agenda"),
        ).toMatchObject({ position: 2147483647 });
        await addAgendaTasks("owner", "agenda", ["later"]);
        const after = (await links()).filter(
            (link) => link.agendaId === "agenda",
        );
        expect(after[4]).toMatchObject({ taskId: "later", origin: "older" });
        expect(after[4].position).toBeGreaterThanOrEqual(
            OLDER_TASK_POSITION_BASE,
        );
        expect(after[4].position).toBeGreaterThan(after[3].position);
        const taskIds = after.map((link) => link.taskId).reverse();
        await reorderAgendaTasks("owner", "agenda", { groupKey, taskIds });
        const reordered = (await links()).filter(
            (link) => link.agendaId === "agenda",
        );
        expect(reordered.map((link) => link.taskId)).toEqual(taskIds);
        expect(reordered.map((link) => link.position)).toEqual(
            after.map((link) => link.position),
        );
    });
    it("round-trips encrypted group order and task positions through backup and restore", async () => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db.insert(recordingTasks).values({
            id: "named",
            userId: "owner",
            createdByUserId: "owner",
            itemId: "source",
            status: "open",
            source: "manual",
            text: encryptText("Named task"),
            assigneeHint: encryptText("Martin Král"),
        });
        await addAgendaTasks("owner", "agenda", ["named"]);
        await reorderAgendaTasks("owner", "agenda", {
            groupKey,
            taskIds: ["one", "existing"],
        });
        await patchMeeting("owner", "agenda", {
            taskGroupOrder: [groupKey, "martin král"],
            previous: { taskGroupOrder: [] },
        });
        const [archive] = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(archive.taskGroupOrder).toEqual([groupKey, "martin král"]);
        const result = await restoreMeetings("owner", {
            meetings: [archive],
            folderIdMap: { first: "first", second: "second" },
            taskIdMap: { existing: "existing", one: "one", named: "named" },
        });
        expect(result.skipped).toEqual([]);
        const restored = await getMeeting("owner", result.restored[0].id);
        expect(restored).toMatchObject({
            taskGroupOrder: archive.taskGroupOrder,
            tasks: [
                { id: "one", position: 7 },
                { id: "existing", position: 100000 },
                { id: "named", position: 100001 },
            ],
        });
    });
    it("archives only the group keys of exported tasks", async () => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Martin Král") })
            .where(eq(recordingTasks.id, "one"));
        await database.db
            .update(meetingAgendas)
            .set({
                taskGroupOrder: encryptJsonField([
                    "eva horáková",
                    "martin král",
                    groupKey,
                ]),
            })
            .where(eq(meetingAgendas.id, "agenda"));
        const [archive] = await collectArchivedMeetings({
            kind: "personal",
            userId: "owner",
        });
        expect(archive.taskGroupOrder).toEqual(["martin král", groupKey]);
    });
    it("returns shared order in web, MCP and recorder groups without exposing the new recorder field", async () => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Martin Král") })
            .where(eq(recordingTasks.id, "one"));
        await patchMeeting("owner", "agenda", {
            taskGroupOrder: ["martin král", groupKey],
            previous: { taskGroupOrder: [] },
        });
        const web = await getMeeting("owner", "agenda");
        const recorder = await (
            await recorderDetail(
                new Request(
                    "https://example.com/api/v1/recorder/agendas/agenda",
                ),
                { params: Promise.resolve({ id: "agenda" }) },
            )
        ).json();
        const tool = MEETING_TOOLS.find((tool) => tool.name === "get_meeting");
        if (!tool) throw new Error("Missing tool");
        const mcp = (await tool.run(
            {
                caller: {
                    kind: "user",
                    userId: "owner",
                    email: "owner@example.com",
                    subject: "owner",
                    clientId: "test",
                    orgUserId: "org",
                    roles: new Set(["tasks:read"]),
                },
                touched: [],
            },
            { meetingId: "agenda" },
        )) as { meeting: { taskGroups: { name: string | null }[] } };
        for (const value of [web, recorder, mcp.meeting])
            expect(value).toMatchObject({
                taskGroups: [{ name: "Martin Král" }, { name: null }],
            });
        expect(recorder).not.toHaveProperty("taskGroupOrder");
    });
    it("moves a point subtree with the existing versioned PATCH and enforces structural rights and depth", async () => {
        const root = await addPoint("owner", "agenda", {
            text: "Root",
            position: 0,
        });
        const child = await addPoint("owner", "agenda", {
            text: "Child",
            parentId: root.id,
            position: 1,
        });
        await addPoint("owner", "agenda", {
            text: "Grandchild",
            parentId: child.id,
            position: 2,
        });
        const second = await addPoint("owner", "agenda", {
            text: "Second",
            position: 3,
        });
        await changePoint("owner", "agenda", root.id, {
            version: 0,
            siblingIndex: 1,
        });
        const detail = await getMeeting("owner", "agenda");
        expect(detail).toMatchObject({
            pointTree: [
                { text: "Second" },
                {
                    text: "Root",
                    children: [
                        { text: "Child", children: [{ text: "Grandchild" }] },
                    ],
                },
            ],
        });
        await expect(
            changePoint("owner", "agenda", root.id, {
                version: 0,
                siblingIndex: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
            changePoint("owner", "agenda", root.id, {
                version: 1,
                parentId: second.id,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await database.db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "stranger",
            folderId: "first",
            state: "accepted",
        });
        await expect(
            changePoint("stranger", "agenda", root.id, {
                version: 1,
                siblingIndex: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
    it("projects each viewer's keys, keeps empty invitees, and preserves hidden slots on writes", async () => {
        await database.db.insert(folderShares).values({
            userId: "owner",
            receiverUserId: "stranger",
            folderId: "first",
            state: "accepted",
        });
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db
            .update(recordingTasks)
            .set({ assigneeHint: encryptText("Jitka Dvořáková") })
            .where(eq(recordingTasks.id, "one"));
        const hidden = ["Martin Král", "Eliška Veselá", "Pavel Malý"];
        for (const [index, name] of hidden.entries()) {
            const id = `hidden-${index}`;
            await database.db.insert(recordingTasks).values({
                id,
                userId: "owner",
                itemId: "outside-source",
                status: "open",
                source: "manual",
                text: encryptText("Private follow up"),
                assigneeHint: encryptText(name),
            });
            await database.db.insert(agendaTasks).values({
                userId: "owner",
                agendaId: "agenda",
                taskId: id,
                origin: "older",
                position: 20 + index,
            });
        }
        await database.db.update(meetingAgendas).set({
            calendarEventId: "event",
            calendarRefreshedAt: new Date(),
            calendarSnapshot: encryptJsonField({
                id: "event",
                attendees: [{ name: "Dana Nová" }],
                organizer: { self: true },
            }),
        });
        const visible = [groupKey, "jitka dvořáková", "dana nová"];
        const stored = [
            "martin král",
            visible[0],
            "eliška veselá",
            visible[1],
            "pavel malý",
            visible[2],
        ];
        await patchMeeting("owner", "agenda", {
            taskGroupOrder: stored,
            previous: { taskGroupOrder: [] },
        });
        expect(await getMeeting("stranger", "agenda")).toMatchObject({
            taskGroupOrder: visible,
        });
        const result = await patchMeeting("stranger", "agenda", {
            taskGroupOrder: [...visible].reverse(),
            previous: { taskGroupOrder: visible },
        });
        expect(result).toMatchObject({
            taskGroupOrder: [...visible].reverse(),
        });
        expect(JSON.stringify(result)).not.toMatch(/martin|eliška|pavel/iu);
        const merged = [
            "martin král",
            visible[2],
            "eliška veselá",
            visible[1],
            "pavel malý",
            visible[0],
        ];
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            taskGroupOrder: merged,
        });
        const ownerOrder = [...merged];
        [ownerOrder[0], ownerOrder[4]] = [ownerOrder[4], ownerOrder[0]];
        await patchMeeting("owner", "agenda", {
            taskGroupOrder: ownerOrder,
            previous: { taskGroupOrder: merged },
        });
        await patchMeeting("stranger", "agenda", {
            taskGroupOrder: visible,
            previous: { taskGroupOrder: [...visible].reverse() },
        });
        expect(await getMeeting("owner", "agenda")).toMatchObject({
            taskGroupOrder: [
                "pavel malý",
                visible[0],
                "eliška veselá",
                visible[1],
                "martin král",
                visible[2],
            ],
        });
        await expect(
            patchMeeting("stranger", "agenda", {
                taskGroupOrder: [...visible].reverse(),
                previous: { taskGroupOrder: [...visible].reverse() },
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("does not expose a mail-only assignee name through MCP group order", async () => {
        await database.db.insert(chatterItems).values({
            id: "mail",
            userId: "owner",
            kind: "mail",
            title: encryptText("Mail"),
            occurredAt: new Date(),
        });
        await database.db.insert(recordingTasks).values({
            id: "mail-task",
            userId: "owner",
            itemId: "mail",
            status: "open",
            source: "manual",
            text: encryptText("Mail follow up"),
            assigneeHint: encryptText("Eliška Veselá"),
        });
        await database.db.insert(agendaTasks).values({
            userId: "owner",
            agendaId: "agenda",
            taskId: "mail-task",
            origin: "older",
            position: 10,
        });
        await patchMeeting("owner", "agenda", {
            taskGroupOrder: ["eliška veselá", groupKey],
            previous: { taskGroupOrder: [] },
        });
        const tool = MEETING_TOOLS.find((tool) => tool.name === "get_meeting");
        if (!tool) throw new Error("Missing tool");
        const roleSets: McpRole[][] = [
            ["tasks:read"],
            ["summaries:read"],
            ["tasks:read", "mail:read"],
        ];
        for (const roles of roleSets) {
            const result = await tool.run(
                {
                    caller: {
                        kind: "user",
                        userId: "owner",
                        email: "owner@example.com",
                        subject: "owner",
                        clientId: "test",
                        orgUserId: "org",
                        roles: new Set(roles),
                    },
                    touched: [],
                },
                { meetingId: "agenda" },
            );
            if (roles.includes("mail:read"))
                expect(JSON.stringify(result)).toContain("eliška veselá");
            else expect(JSON.stringify(result)).not.toMatch(/eliška/iu);
        }
    });
    it("uses no global DB connection inside task or group order transactions", async () => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        holder.forbidGlobalInTransaction = true;
        await reorderAgendaTasks("owner", "agenda", {
            groupKey,
            taskIds: ["one", "existing"],
        });
        await patchMeeting("owner", "agenda", {
            taskGroupOrder: [groupKey],
            previous: { taskGroupOrder: [] },
        });
    });
    it.each(
        (["tasks", "groups"] as const).flatMap((order) =>
            (["hint", "assignee", "name", "status", "deleted"] as const).map(
                (change) => ({ order, change }),
            ),
        ),
    )("refuses $order ordering after a $change change between preload and lock", async ({
        order,
        change,
    }) => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        await database.db.insert(people).values({
            id: "assignee",
            userId: "owner",
            displayName: encryptText("Jitka Dvořáková"),
        });
        if (change === "name")
            await database.db
                .update(recordingTasks)
                .set({ assigneePersonId: "assignee" })
                .where(inArray(recordingTasks.id, ["one", "existing"]));
        const before = await links();
        const original = taskQueries.getVisibleTasks;
        vi.spyOn(taskQueries, "getVisibleTasks").mockImplementationOnce(
            async (...args) => {
                const loaded = await original(...args);
                if (change === "hint")
                    await database.db
                        .update(recordingTasks)
                        .set({ assigneeHint: encryptText("Martin Král") })
                        .where(eq(recordingTasks.id, "one"));
                if (change === "assignee")
                    await database.db
                        .update(recordingTasks)
                        .set({ assigneePersonId: "assignee" })
                        .where(eq(recordingTasks.id, "one"));
                if (change === "name")
                    await database.db
                        .update(people)
                        .set({ displayName: encryptText("Martin Král") })
                        .where(eq(people.id, "assignee"));
                if (change === "status")
                    await database.db
                        .update(recordingTasks)
                        .set({ status: "proposed" })
                        .where(eq(recordingTasks.id, "one"));
                if (change === "deleted")
                    await database.db
                        .update(chatterItems)
                        .set({ deletedAt: new Date() })
                        .where(eq(chatterItems.id, "source"));
                return loaded;
            },
        );
        holder.forbidGlobalInTransaction = true;
        const response =
            order === "tasks"
                ? await call(reorderTasks, {
                      groupKey:
                          change === "name" ? "jitka dvořáková" : groupKey,
                      taskIds: ["one", "existing"],
                  })
                : await call(patchAgenda, {
                      taskGroupOrder:
                          change === "name" ? ["jitka dvořáková"] : [groupKey],
                      previous: { taskGroupOrder: [] },
                  });
        expect(response.status).toBe(409);
        expect(await links()).toEqual(before);
        expect(await version()).toBe(1);
        const [stored] = await database.db.select().from(meetingAgendas);
        expect(stored.taskGroupOrder).toBeNull();
    });
    it.each([
        "remove",
        "unlink",
        "add",
        "move",
    ])("rejects task link %s between preload and locking", async (change) => {
        await addAgendaTasks("owner", "agenda", ["one"]);
        const original = taskQueries.getVisibleTasks;
        vi.spyOn(taskQueries, "getVisibleTasks").mockImplementationOnce(
            async (...args) => {
                const loaded = await original(...args);
                if (change === "remove")
                    await database.db
                        .update(agendaTasks)
                        .set({ removedAt: new Date() })
                        .where(eq(agendaTasks.taskId, "one"));
                if (change === "unlink")
                    await database.db
                        .delete(agendaTasks)
                        .where(eq(agendaTasks.taskId, "one"));
                if (change === "add")
                    await database.db.insert(agendaTasks).values({
                        userId: "owner",
                        agendaId: "agenda",
                        taskId: "two",
                        origin: "older",
                        position: 20,
                    });
                if (change === "move") {
                    await database.db
                        .insert(meetingAgendas)
                        .values({ id: "other-agenda", userId: "owner" });
                    await database.db
                        .update(agendaTasks)
                        .set({ agendaId: "other-agenda" })
                        .where(eq(agendaTasks.taskId, "one"));
                }
                return loaded;
            },
        );
        await expect(
            reorderAgendaTasks("owner", "agenda", {
                groupKey,
                taskIds: ["one", "existing"],
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await version()).toBe(1);
    });
    it("adds a point right after its anchor among tied siblings by sibling index", async () => {
        const a = await addPoint("owner", "agenda", { text: "A" });
        const b = await addPoint("owner", "agenda", { text: "B" });
        await database.db.update(agendaPoints).set({ position: 0 });
        const before = await getMeeting("owner", "agenda");
        if (before.unchanged) throw new Error("Missing detail");
        const [first, second] = before.pointTree.map((point) => point.id);
        const added = await addPoint("owner", "agenda", {
            text: "New",
            siblingIndex: 1,
        });
        const after = await getMeeting("owner", "agenda");
        if (after.unchanged) throw new Error("Missing detail");
        expect(after.pointTree.map((point) => point.id)).toEqual([
            first,
            added.id,
            second,
        ]);
        expect(new Set([first, second])).toEqual(new Set([a.id, b.id]));
        await expect(
            addPoint("owner", "agenda", {
                text: "Both",
                siblingIndex: 0,
                position: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });
    it.each([
        0, 99999,
    ])("renumbers tied and capped point siblings atomically (%s)", async (position) => {
        const a = await addPoint("owner", "agenda", { text: "A" });
        const b = await addPoint("owner", "agenda", { text: "B" });
        const c = await addPoint("owner", "agenda", { text: "C" });
        const child = await addPoint("owner", "agenda", {
            text: "Child",
            parentId: a.id,
        });
        await database.db.update(agendaPoints).set({ position });
        if (position !== 0)
            await database.db
                .update(agendaPoints)
                .set({ position: 100000 })
                .where(inArray(agendaPoints.id, [b.id, c.id]));
        const before = await getMeeting("owner", "agenda");
        if (before.unchanged) throw new Error("Missing detail");
        const siblings = before.pointTree;
        const first = siblings[0];
        const order = siblings.map((point) => point.id);
        [order[0], order[1]] = [order[1], order[0]];
        await changePoint("owner", "agenda", first.id, {
            version: 0,
            siblingIndex: 1,
        });
        const after = await getMeeting("owner", "agenda");
        if (after.unchanged) throw new Error("Missing detail");
        expect(after.pointTree.map((point) => point.id)).toEqual(order);
        expect(after.points.every((point) => point.position <= 100000)).toBe(
            true,
        );
        expect(
            after.points.find((point) => point.id === child.id)?.parentId,
        ).toBe(a.id);
        await expect(
            changePoint("owner", "agenda", first.id, {
                version: 0,
                siblingIndex: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
            changePoint("owner", "agenda", first.id, {
                version: 1,
                siblingIndex: 99,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
            changePoint("owner", "agenda", first.id, {
                version: 1,
                siblingIndex: 0,
                position: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(after.pointTree).toHaveLength(3);
    });
});
