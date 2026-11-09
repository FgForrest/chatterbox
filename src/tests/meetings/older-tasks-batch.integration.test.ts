import { asc, eq } from "drizzle-orm";
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
    agendaTasks,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskMentions,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const holder = vi.hoisted(() => ({
    database: null as Record<PropertyKey, unknown> | null,
    caller: "owner",
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
        AUTHZ_MODE: "local",
        IS_HOSTED: false,
        BETTER_AUTH_SECRET: "meeting-batch-test",
        APP_URL: "https://example.com",
    },
}));
vi.mock("@/lib/org/config", () => ({
    getOrgUserId: async () => null,
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
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { POST } from "@/app/api/meetings/[id]/tasks/route";
import {
    addAgendaTask,
    addAgendaTasks,
    getMeeting,
    patchMeeting,
} from "@/lib/meetings/service";

const url = getTestDatabaseUrl();
describe.skipIf(!url)("older agenda task batches (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "older_task_batch",
        );
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
        holder.caller = "owner";
        const db = database.db;
        await db.delete(users);
        await db.insert(users).values(
            ["owner", "stranger"].map((id) => ({
                id,
                email: `${id}@example.com`,
            })),
        );
        await db.insert(recordingFolders).values(
            ["first", "second", "outside"].map((id) => ({
                id,
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
    const post = (body: unknown) =>
        POST(
            new Request("https://example.com/api/meetings/agenda/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id: "agenda" }) },
        );
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
    it("adds tasks from every agenda folder in selection order and bumps once", async () => {
        expect((await post({ taskIds: ["two", "one", "three"] })).status).toBe(
            200,
        );
        expect(
            (await links()).map((row) => [row.taskId, row.position]),
        ).toEqual([
            ["existing", 7],
            ["two", 100000],
            ["one", 100001],
            ["three", 100002],
        ]);
        expect(await version()).toBe(1);
    });
    it("appends a replacement snapshot after retained older tasks in selection order", async () => {
        await addAgendaTasks("owner", "agenda", ["two", "one"]);
        await database.db.insert(chatterItems).values({
            id: "replacement-source",
            userId: "owner",
            kind: "audio",
            title: encryptText("Next planning session"),
            occurredAt: new Date(),
        });
        const snapshotIds = Array.from(
            { length: 10 },
            (_, position) => `snapshot-${position}`,
        );
        await database.db.insert(recordingTasks).values(
            snapshotIds.map((id, position) => ({
                id,
                itemId: "replacement-source",
                userId: "owner",
                status: "open" as const,
                source: "manual" as const,
                text: encryptText("Review milestone"),
                position,
            })),
        );

        const detail = await patchMeeting("owner", "agenda", {
            taskSourceItemId: "replacement-source",
        });
        if (detail.unchanged) throw new Error("Expected meeting detail");
        expect(detail.snapshotSourceItemId).toBe("replacement-source");
        expect(detail.tasks.map((task) => task.agendaOrigin)).toEqual([
            "older",
            "older",
            ...snapshotIds.map(() => "last_meeting"),
        ]);
        expect(detail.tasks.map((task) => task.id)).toEqual([
            "two",
            "one",
            ...snapshotIds,
        ]);
        expect(detail.tasks.slice(0, 2).map((task) => task.position)).toEqual([
            100000, 100001,
        ]);
        expect(detail.tasks.slice(2).map((task) => task.position)).toEqual(
            snapshotIds.map((_, index) => 100002 + index),
        );
    });
    it("orders equal agenda positions by task id", async () => {
        await database.db.insert(agendaTasks).values(
            ["two", "one"].map((taskId) => ({
                agendaId: "agenda",
                userId: "owner",
                taskId,
                origin: "older" as const,
                position: 7,
            })),
        );
        const detail = await getMeeting("owner", "agenda");
        if (detail.unchanged) throw new Error("Expected meeting detail");
        expect(detail.tasks.map((task) => task.id)).toEqual([
            "existing",
            "one",
            "two",
        ]);
    });
    it("refuses all invisible or missing ids without adding valid tasks or bumping the agenda", async () => {
        await database.db.insert(taskMentions).values({
            taskId: "invisible",
            itemId: "source",
            userId: "owner",
            view: "private",
            statementAt: new Date(),
            matchDecision: "accepted",
        });
        const response = await post({
            taskIds: ["one", "invisible", "two", "missing"],
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            details: { refusedTaskIds: ["invisible", "missing"] },
        });
        expect((await links()).map((row) => row.taskId)).toEqual(["existing"]);
        expect(await version()).toBe(0);
    });
    it("restores removed membership at the end and preserves its note and origin", async () => {
        await database.db.insert(agendaTasks).values({
            agendaId: "agenda",
            userId: "owner",
            taskId: "one",
            origin: "last_meeting",
            position: 2,
            removedAt: new Date(),
            note: encryptText("Review next time"),
        });
        expect((await post({ taskIds: ["two", "one"] })).status).toBe(200);
        const rows = await links();
        expect(rows.map((row) => [row.taskId, row.position])).toEqual([
            ["existing", 7],
            ["two", 100000],
            ["one", 100001],
        ]);
        expect(rows[2].removedAt).toBeNull();
        expect(rows[2].origin).toBe("last_meeting");
        expect(decryptText(rows[2].note ?? "")).toBe("Review next time");
    });
    it("deduplicates ids while preserving their first selection order", async () => {
        expect(
            (await post({ taskIds: ["two", "one", "two", "one"] })).status,
        ).toBe(200);
        expect(
            (await links()).map((row) => [row.taskId, row.position]),
        ).toEqual([
            ["existing", 7],
            ["two", 100000],
            ["one", 100001],
        ]);
        expect(await version()).toBe(1);
    });
    it("skips active members while adding the remaining tasks in selection order", async () => {
        await database.db
            .update(agendaTasks)
            .set({ note: encryptText("Keep this note") })
            .where(eq(agendaTasks.taskId, "existing"));
        const [existing] = await links();
        expect(
            (await post({ taskIds: ["two", "existing", "one"] })).status,
        ).toBe(200);
        const rows = await links();
        expect(rows[0]).toEqual(existing);
        expect(rows.map((row) => [row.taskId, row.position])).toEqual([
            ["existing", 7],
            ["two", 100000],
            ["one", 100001],
        ]);
        expect(await version()).toBe(1);
    });
    it("succeeds without changing links or the agenda when all ids are active", async () => {
        await database.db
            .update(agendaTasks)
            .set({ note: encryptText("Keep this note") })
            .where(eq(agendaTasks.taskId, "existing"));
        const beforeLinks = await links();
        const beforeAgendas = await database.db.select().from(meetingAgendas);
        expect((await post({ taskIds: ["existing"] })).status).toBe(200);
        await addAgendaTask("owner", "agenda", "existing");
        expect(await links()).toEqual(beforeLinks);
        expect(await database.db.select().from(meetingAgendas)).toEqual(
            beforeAgendas,
        );
    });
    it("retains the single-task route and MCP service entry point", async () => {
        expect((await post({ taskId: "one" })).status).toBe(200);
        await addAgendaTask("owner", "agenda", "two");
        expect((await links()).map((row) => row.taskId)).toEqual([
            "existing",
            "one",
            "two",
        ]);
    });
    it("rejects tasks outside all agenda folders and rolls back the batch", async () => {
        const response = await post({ taskIds: ["one", "outside"] });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            details: { refusedTaskIds: ["outside"] },
        });
        expect(await links()).toHaveLength(1);
    });
    it("accepts folder membership through an accepted mention", async () => {
        await database.db.insert(taskMentions).values({
            taskId: "outside",
            itemId: "source",
            userId: "owner",
            view: "private",
            statementAt: new Date(),
            matchDecision: "accepted",
        });
        expect((await post({ taskIds: ["outside"] })).status).toBe(200);
        expect((await links()).map((row) => row.taskId)).toEqual([
            "existing",
            "outside",
        ]);
    });
    it.each([
        "done",
        "dropped",
        "proposed",
    ] as const)("refuses %s tasks atomically", async (status) => {
        await database.db
            .update(recordingTasks)
            .set({ status })
            .where(eq(recordingTasks.id, "two"));
        expect((await post({ taskIds: ["one", "two"] })).status).toBe(404);
        expect(await links()).toHaveLength(1);
    });
    it("refuses deleted sources and personal tasks while allowing current members", async () => {
        await database.db
            .update(chatterItems)
            .set({ deletedAt: new Date() })
            .where(eq(chatterItems.id, "other-source"));
        await database.db.insert(recordingTasks).values({
            id: "personal",
            userId: "owner",
            folderId: "first",
            source: "personal",
            status: "open",
            text: encryptText("Own task"),
        });
        const response = await post({
            taskIds: ["one", "two", "personal", "existing"],
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            details: { refusedTaskIds: ["two", "personal"] },
        });
        expect(await links()).toHaveLength(1);
        expect(await version()).toBe(0);
    });
    it("still refuses an active member that is no longer eligible", async () => {
        await database.db
            .update(recordingTasks)
            .set({ status: "done" })
            .where(eq(recordingTasks.id, "existing"));
        const response = await post({ taskIds: ["one", "existing"] });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            details: { refusedTaskIds: ["existing"] },
        });
        expect(await links()).toHaveLength(1);
        expect(await version()).toBe(0);
    });
    it("requires agenda edit access and keeps absorbed agendas read-only", async () => {
        holder.caller = "stranger";
        expect((await post({ taskIds: ["one"] })).status).toBe(404);
        holder.caller = "owner";
        await database.db
            .update(meetingAgendas)
            .set({ recordingItemId: "source", absorbedAt: new Date() })
            .where(eq(meetingAgendas.id, "agenda"));
        expect((await post({ taskIds: ["one"] })).status).toBe(409);
        expect(await links()).toHaveLength(1);
    });
    it("serializes concurrent batches so each appends contiguous positions", async () => {
        await Promise.all([
            addAgendaTasks("owner", "agenda", ["two", "one"]),
            addAgendaTasks("owner", "agenda", ["three"]),
        ]);
        const rows = await links();
        expect(rows.map((row) => row.position)).toEqual([
            7, 100000, 100001, 100002,
        ]);
        const ids = rows.map((row) => row.taskId);
        expect(ids.indexOf("one")).toBe(ids.indexOf("two") + 1);
        expect(await version()).toBe(2);
    });
    it("accepts overlapping concurrent batches without moving existing links", async () => {
        await Promise.all([
            addAgendaTasks("owner", "agenda", ["one", "two"]),
            addAgendaTasks("owner", "agenda", ["two", "three"]),
        ]);
        const rows = await links();
        expect(rows.map((row) => row.position)).toEqual([
            7, 100000, 100001, 100002,
        ]);
        expect(rows.map((row) => row.taskId).sort()).toEqual([
            "existing",
            "one",
            "three",
            "two",
        ]);
        expect(await version()).toBe(2);
    });
    it.each([
        {},
        { taskIds: [] },
        { taskIds: [""] },
        { taskIds: [42] },
        { taskIds: ["x".repeat(256)] },
        { taskIds: Array.from({ length: 501 }, () => "one") },
        { taskIds: ["one"], taskId: "two" },
    ])("rejects malformed or oversized input: %j", async (body) => {
        expect((await post(body)).status).toBe(400);
        expect(await links()).toHaveLength(1);
        expect(await version()).toBe(0);
    });
});
