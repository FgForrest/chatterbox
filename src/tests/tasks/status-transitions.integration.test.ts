import type { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import unzipper from "unzipper";
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
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
    taskStatusTransitions,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import type { TaskViewer } from "@/lib/tasks/access";
import type { ArchivedTask } from "@/lib/tasks/archive";
import { personalTasksForArchive, tasksForArchive } from "@/lib/tasks/archive";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import { applyRoutedTaskProposal } from "@/lib/tasks/routing";
import { writeTaskProposalsInTx } from "@/lib/tasks/store";
import {
    acceptReview,
    addTask,
    createPersonalTask,
    mergeTaskIntoTask,
    updateTask,
} from "@/lib/tasks/tasks";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { ref } = vi.hoisted(() => ({
    ref: { current: null as Record<PropertyKey, unknown> | null },
}));
vi.mock("@/db", () => ({
    db: new Proxy(
        {},
        {
            get(_target, key) {
                if (!ref.current) throw new Error("Database not ready");
                const value = ref.current[key];
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
        ORG_ACCOUNT_EMAIL: "org@example.test",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-status-history-secret",
        DATABASE_URL: "postgres://unused",
    },
}));
vi.mock("@/lib/org/config", () => ({
    assertOrgScopeWritable: vi.fn(),
    getOrgUserId: async () => "org",
    isOrgScopeEnabled: () => true,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
const url = getTestDatabaseUrl();
const viewer: TaskViewer = {
    userId: "owner",
    emailHash: "owner-hash",
    orgUserId: "org",
    isOrg: false,
    isCurator: false,
};

describe.skipIf(!url)("task status history (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url as string,
            "task_status_history",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    }, 30_000);
    beforeEach(async () => {
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: "owner", email: "owner@example.test" },
            { id: "other", email: "other@example.test" },
            { id: "org", email: "org@example.test", role: "org" },
        ]);
        await database.db.insert(chatterItems).values([
            {
                id: "first",
                userId: "owner",
                kind: "mail",
                title: encryptText("First"),
                occurredAt: new Date("2026-01-01T12:00:00Z"),
            },
            {
                id: "later",
                userId: "owner",
                kind: "mail",
                title: encryptText("Later"),
                occurredAt: new Date("2026-01-02T12:00:00Z"),
            },
            {
                id: "shared-source",
                userId: "other",
                kind: "mail",
                title: encryptText("Shared source"),
                occurredAt: new Date("2026-01-03T12:00:00Z"),
            },
        ]);
        await database.db.insert(recordingFolders).values({
            id: "shared",
            userId: "org",
            name: encryptText("Shared"),
            nameHash: "shared",
        });
        await database.db.insert(recordingFolderAssignments).values({
            itemId: "shared-source",
            userId: "other",
            folderId: "shared",
        });
    });
    async function history(taskId: string) {
        return database.db
            .select()
            .from(taskStatusTransitions)
            .where(eq(taskStatusTransitions.taskId, taskId))
            .orderBy(taskStatusTransitions.createdAt, taskStatusTransitions.id);
    }
    it("logs manual creation, changes and no-ops exactly once, including concurrent version checks", async () => {
        const task = await addTask(viewer, "first", {
            text: "Manual task",
            status: "open",
        });
        const results = await Promise.allSettled([
            updateTask(viewer, task.id, {
                version: task.version,
                status: "done",
            }),
            updateTask(viewer, task.id, {
                version: task.version,
                status: "done",
            }),
        ]);
        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const current = results.find((result) => result.status === "fulfilled");
        if (current?.status !== "fulfilled")
            throw new Error("No successful update");
        const unchanged = await updateTask(viewer, task.id, {
            version: current.value.version,
            status: "done",
        });
        const reopened = await updateTask(viewer, task.id, {
            version: unchanged.version,
            status: "open",
        });
        await updateTask(viewer, task.id, {
            version: reopened.version,
            status: "dropped",
        });
        const rows = await history(task.id);
        expect(rows.map((row) => [row.fromStatus, row.toStatus])).toEqual([
            [null, "open"],
            ["open", "done"],
            ["done", "open"],
            ["open", "dropped"],
        ]);
        expect(rows.every((row) => row.actorUserId === "owner")).toBe(true);
    });
    it("rolls back the task update when inserting its transition fails", async () => {
        const task = await createPersonalTask(viewer, { text: "Atomic task" });
        const [before] = await database.db
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        const beforeHistory = await history(task.id);
        await database.sql`create function reject_transition() returns trigger language plpgsql as $$
            begin
                if not exists (select 1 from recording_tasks where id = new.task_id and status = 'done') then
                    raise exception 'task update did not precede the transition';
                end if;
                raise exception 'synthetic transition write failure';
            end $$`;
        await database.sql`create trigger reject_transition before insert on task_status_transitions for each row execute function reject_transition()`;
        try {
            await expect(
                updateTask(viewer, task.id, {
                    version: task.version,
                    status: "done",
                }),
            ).rejects.toMatchObject({
                cause: { message: "synthetic transition write failure" },
            });
        } finally {
            await database.sql`drop trigger reject_transition on task_status_transitions`;
            await database.sql`drop function reject_transition()`;
        }
        expect(
            (
                await database.db
                    .select()
                    .from(recordingTasks)
                    .where(eq(recordingTasks.id, task.id))
            )[0],
        ).toEqual(before);
        expect(await history(task.id)).toEqual(beforeHistory);
        await updateTask(viewer, task.id, {
            version: task.version,
            status: "done",
        });
        expect(
            (await history(task.id)).map((row) => [
                row.fromStatus,
                row.toStatus,
            ]),
        ).toEqual([
            [null, "open"],
            ["open", "done"],
        ]);
    });
    it("logs own-task creation and rolls back the log with failed transactions", async () => {
        const task = await createPersonalTask(viewer, { text: "Own task" });
        expect(
            (await history(task.id)).map((row) => [
                row.fromStatus,
                row.toStatus,
            ]),
        ).toEqual([[null, "open"]]);
        await expect(
            updateTask(viewer, task.id, { version: 99, status: "done" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await history(task.id)).toHaveLength(1);
        await database.db
            .delete(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(await history(task.id)).toEqual([]);
    });
    it("logs summary proposals and review acceptance, while dismissal cascades its proposal history", async () => {
        const proposed = (text: string) => ({
            text,
            fingerprint: text,
            assigneePersonId: null,
            assigneeHint: null,
            assigneeCheck: false,
            dueDate: null,
            duePhrase: null,
            quote: null,
            evidenceStartMs: null,
        });
        await database.db.transaction((tx) =>
            writeTaskProposalsInTx(tx, {
                recordingId: "first",
                ownerUserId: "owner",
                actorUserId: "other",
                proposals: {
                    source: "riffado",
                    reviewer: viewer,
                    fingerprintOf: (text) => text,
                    tasks: [proposed("From summary")],
                    updates: [],
                },
            }),
        );
        const [task] = await database.db.select().from(recordingTasks);
        expect(
            (await history(task.id)).map((row) => [
                row.fromStatus,
                row.toStatus,
                row.actorUserId,
            ]),
        ).toEqual([[null, "proposed", "other"]]);
        const dismissed = await addTask(viewer, "first", {
            text: "Dismissed proposal",
            status: "proposed",
        });
        await updateTask(viewer, dismissed.id, {
            version: dismissed.version,
            ticked: false,
        });
        const result = await acceptReview(viewer, "first");
        expect(result.accepted).toBe(1);
        expect(result.rejected).toBe(1);
        expect(
            (await history(task.id)).map((row) => [
                row.fromStatus,
                row.toStatus,
                row.actorUserId,
            ]),
        ).toEqual([
            [null, "proposed", "other"],
            ["proposed", "open", "owner"],
        ]);
        expect(await history(dismissed.id)).toEqual([]);
    });
    it.each([
        "done",
        "drop",
    ] as const)("logs %s applied from a source-item review exactly once", async (kind) => {
        const task = await addTask(viewer, "first", {
            text: "Target",
            status: "open",
        });
        await database.db.insert(taskUpdateProposals).values({
            taskId: task.id,
            itemId: "later",
            userId: "owner",
            kind,
            state: "awaiting_source_review",
            ticked: true,
            version: task.version,
            statementAt: new Date("2026-01-02T12:00:00Z"),
        });
        expect((await acceptReview(viewer, "later")).updatesApplied).toBe(1);
        expect(
            (await history(task.id)).map((row) => [
                row.fromStatus,
                row.toStatus,
            ]),
        ).toEqual([
            [null, "open"],
            ["open", kind === "done" ? "done" : "dropped"],
        ]);
    });
    it("logs a routed target-review status change with the applying actor and leaves attachment notices unchanged", async () => {
        const task = await addTask(viewer, "first", {
            text: "Target",
            status: "open",
        });
        const [proposal] = await database.db
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: "shared-source",
                userId: "other",
                kind: "done",
                state: "awaiting_target_review",
                routedTo: ["owner"],
                version: task.version,
                statementAt: new Date("2026-01-03T12:00:00Z"),
                decidedByUserId: "other",
            })
            .returning();
        expect(
            await applyRoutedTaskProposal(viewer, "shared-source", proposal.id),
        ).toMatchObject({ state: "applied" });
        const rows = await history(task.id);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({
            fromStatus: "open",
            toStatus: "done",
            actorUserId: "owner",
        });
        await expect(
            applyRoutedTaskProposal(viewer, "shared-source", proposal.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(await history(task.id)).toHaveLength(2);
    });
    it("serializes concurrent routed and manual status edits with one matching transition", async () => {
        const task = await addTask(viewer, "first", {
            text: "Concurrent task",
            status: "open",
        });
        const [proposal] = await database.db
            .insert(taskUpdateProposals)
            .values({
                taskId: task.id,
                itemId: "shared-source",
                userId: "other",
                kind: "done",
                state: "awaiting_target_review",
                routedTo: ["owner"],
                version: task.version,
                statementAt: new Date("2026-01-03T12:00:00Z"),
                decidedByUserId: "other",
            })
            .returning();
        const [manual, routed] = await Promise.allSettled([
            updateTask(viewer, task.id, {
                version: task.version,
                status: "dropped",
            }),
            applyRoutedTaskProposal(viewer, "shared-source", proposal.id),
        ]);
        const [current] = await database.db
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        const rows = await history(task.id);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({
            fromStatus: "open",
            toStatus: current.status,
            actorUserId: "owner",
        });
        expect(current.version).toBe(task.version + 1);
        if (manual.status === "fulfilled") {
            expect(current.status).toBe("dropped");
            if (routed.status === "fulfilled")
                expect(routed.value.state).toBe("obsolete");
            else expect(routed.reason).toMatchObject({ statusCode: 404 });
        } else {
            expect(manual.reason).toMatchObject({ statusCode: 409 });
            expect(current.status).toBe("done");
            expect(routed).toMatchObject({
                status: "fulfilled",
                value: { state: "applied" },
            });
        }
    });
    it("merges open tasks without inventing a status change and cascades the deleted task's log", async () => {
        const source = await createPersonalTask(viewer, { text: "Source" });
        const target = await createPersonalTask(viewer, { text: "Target" });
        await mergeTaskIntoTask(viewer, source.id, target.id);
        expect(await history(source.id)).toEqual([]);
        expect(await history(target.id)).toHaveLength(1);
    });
    it("round-trips optional history in task archives, including own tasks, unknown actors and legacy archives", async () => {
        const own = await createPersonalTask(viewer, { text: "Own task" });
        await updateTask(viewer, own.id, {
            version: own.version,
            status: "done",
        });
        const item = await addTask(viewer, "first", {
            text: "Item task",
            status: "open",
        });
        await updateTask(viewer, item.id, {
            version: item.version,
            status: "dropped",
        });
        const scope = { kind: "personal" as const, userId: "owner" };
        await database.db.insert(mailMessages).values({
            id: "first",
            userId: "owner",
            rawHash: "archived-mail",
            receivedAt: new Date("2026-01-01T12:00:00Z"),
            sizeBytes: 0,
            auth: encryptJsonField({}),
            senderVerified: true,
        });
        let uploaded = Buffer.alloc(0);
        const storage = {
            uploadFile: async (key: string) => key,
            downloadFile: async () => {
                throw new Error("No file");
            },
            downloadStream: async () => {
                throw new Error("No file");
            },
            uploadStream: async (key: string, stream: Readable) => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream)
                    chunks.push(
                        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                    );
                uploaded = Buffer.concat(chunks);
                return key;
            },
            exists: async () => false,
            getSignedUrl: async () => "",
            deleteFile: async () => {},
            testConnection: async () => true,
        };
        await buildAndUploadExportArchive({
            scope,
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "test/archive.zip",
        });
        const zipped = await unzipper.Open.buffer(uploaded);
        const personalFile = zipped.files.find(
            (file) => file.path === "tasks/personal.json",
        );
        if (!personalFile)
            throw new Error("Own tasks missing from full archive");
        const personal = JSON.parse(
            (await personalFile.buffer()).toString("utf8"),
        ) as ArchivedTask[];
        expect(personal).toEqual(await personalTasksForArchive(scope));
        expect(zipped.files.some((file) => /snapshot/.test(file.path))).toBe(
            false,
        );
        const items =
            (await tasksForArchive(scope, ["first"], { proposals: true })).get(
                "first",
            ) ?? [];
        expect(personal[0].statusTransitions).toHaveLength(2);
        expect(items[0].statusTransitions).toHaveLength(2);
        const mailFile = zipped.files.find((file) =>
            file.path.endsWith("/mail.json"),
        );
        if (!mailFile) throw new Error("Mail tasks missing from full archive");
        const archivedMail = JSON.parse(
            (await mailFile.buffer()).toString("utf8"),
        ) as { tasks: ArchivedTask[] };
        expect(archivedMail.tasks).toEqual(items);
        const original = await history(own.id);
        const archive = JSON.parse(
            JSON.stringify({
                personal,
                items: [{ itemId: "first", tasks: archivedMail.tasks }],
            }),
        ) as unknown;
        await database.db.delete(recordingTasks);
        expect(await restoreTaskArchive(viewer, archive)).toMatchObject({
            tasks: 2,
        });
        expect(await history(own.id)).toEqual(original);
        expect(await restoreTaskArchive(viewer, archive)).toMatchObject({
            tasks: 0,
            skipped: 2,
        });
        expect(await history(own.id)).toHaveLength(2);
        await database.db.delete(recordingTasks);
        const unknownActor = personal.map((task) => ({
            ...task,
            statusTransitions: task.statusTransitions?.map((row) => ({
                ...row,
                actorUserId: "account-from-another-instance",
            })),
        }));
        await restoreTaskArchive(viewer, { personal: unknownActor });
        expect(
            (await history(own.id)).every((row) => row.actorUserId === null),
        ).toBe(true);
        await database.db.delete(recordingTasks);
        await restoreTaskArchive(viewer, {
            personal: personal.map(
                ({ statusTransitions: _history, ...task }) => task,
            ),
        });
        expect(await history(own.id)).toEqual([]);
        expect(
            (await database.db.select().from(recordingTasks))[0].status,
        ).toBe("done");
    });
});
