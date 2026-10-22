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
import { DELETE as deleteSummary } from "@/app/api/recordings/[id]/summary/route";
import { GET as mergeGet } from "@/app/api/tasks/[taskId]/merge/route";
import { POST as restorePost } from "@/app/api/tasks/restore/route";
import { deleteMailSummaries } from "@/db/queries/mail-retention";
import { deleteSummaryForRecording } from "@/db/queries/retention";
import {
    aiEnhancements,
    chatterItems,
    people,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskFollowers,
    taskMentions,
    taskUnfollows,
    taskUpdateProposals,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import { TASK_TOOLS } from "@/lib/mcp/tools/tasks";
import { assertOrgScopeWritable } from "@/lib/org/config";
import { eraseLocalArtifact, eraseMailSummary } from "@/lib/recordings/erase";
import { searchTasks } from "@/lib/search/app-search";
import type { StorageProvider } from "@/lib/storage/types";
import type { TaskViewer } from "@/lib/tasks/access";
import {
    followsForArchive,
    personalTasksForArchive,
    tasksForArchive,
} from "@/lib/tasks/archive";
import { deleteItemTaskDataInTx } from "@/lib/tasks/mentions";
import {
    loadTasksPromptContext,
    MERGE_CANDIDATE_SCAN_LIMIT,
    searchAssignedMergeCandidates,
} from "@/lib/tasks/proposals";
import { restoreTaskArchive } from "@/lib/tasks/restore";
import {
    addTask,
    countNewTasks,
    createPersonalTask,
    followTask,
    getCallerTask,
    getVisibleTask,
    listTasks,
    mergeTaskIntoTask,
    previewTaskMerge,
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
    removeRecordingSidecar: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: async () => true }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({
        user: { id: "author", email: "author@example.test" },
    }),
}));
vi.mock("@/lib/tasks/route-helpers", () => ({
    requireTaskViewer: async () => viewer("author"),
    enforceTaskWriteRateLimit: vi.fn(),
    enforceTaskMergeSearchRateLimit: vi.fn(),
    invalid: (message: string) => new Error(message),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: async () => ({ deleteFile: vi.fn() }),
}));

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
    const tool = TASK_TOOLS.find((tool) => tool.name === name);
    if (!tool) throw new Error("Missing task tool");
    const identity = caller(userId, mail);
    const result = await tool.run(
        { caller: identity, touched: [] },
        z.object(tool.input(identity)).parse(input),
    );
    return z.object(tool.output).parse(result);
}

describe.skipIf(!url)("#253 assignee task desk", () => {
    let database: TestPostgresDatabase;
    const db = () => database.db;
    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            url ?? "",
            "assignee_tasks",
        );
        ref.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        ref.current = null;
        await database?.dispose();
    });
    beforeEach(async () => {
        vi.mocked(assertOrgScopeWritable).mockReset();
        await db().delete(users);
        await db()
            .insert(users)
            .values(
                ["author", "assignee", "member", "curator", "org"].map(
                    (id) => ({
                        id,
                        email: `${id}@example.test`,
                        name: id,
                        role:
                            id === "org" ? ("org" as const) : ("user" as const),
                    }),
                ),
            );
        await db()
            .insert(recordingFolders)
            .values({
                id: "team",
                userId: "org",
                name: encryptText("Team"),
                nameHash: "team",
                kind: "public",
            });
        await db()
            .insert(people)
            .values({
                id: "assigned-person",
                userId: "org",
                displayName: encryptText("Luma Veln"),
                primaryEmailHash: lookupHash("assignee@example.test"),
            });
        for (const id of ["private", "shared", "other"]) {
            await db()
                .insert(chatterItems)
                .values({
                    id,
                    userId: "author",
                    kind: "mail",
                    title: encryptText(id),
                    occurredAt: new Date("2026-10-01T10:00:00Z"),
                });
            if (id !== "private")
                await db()
                    .insert(recordingFolderAssignments)
                    .values({ itemId: id, userId: "author", folderId: "team" });
        }
    });
    const list = (
        id: string,
        tab: TaskTab,
        organization = false,
        folderId: string | null = null,
    ) =>
        listTasks(viewer(id), {
            tab,
            state: "all",
            folderId,
            due: null,
            today: null,
            sort: "created",
            organization,
        });
    const itemTask = (itemId = "shared", text = "Send the revised plan") =>
        addTask(viewer("author"), itemId, {
            text,
            assigneePersonId: "assigned-person",
            status: "open",
        });

    async function audioItem() {
        await db()
            .insert(chatterItems)
            .values({
                id: "audio",
                userId: "author",
                kind: "audio",
                title: encryptText("Meeting"),
                occurredAt: new Date("2026-10-01T10:00:00Z"),
            });
        await db()
            .insert(recordings)
            .values({
                id: "audio",
                userId: "author",
                deviceSn: "browser",
                plaudFileId: "audio",
                duration: 1000,
                endTime: new Date("2026-10-01T10:00:01Z"),
                filesize: 100,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "audio.wav",
                plaudVersion: "1",
            });
    }

    it.each([
        "summary DELETE",
        "summary retention",
        "mail retention",
        "erase summary",
        "erase transcript",
        "erase audio",
        "erase mail summary",
        "item deletion",
    ])("preserves own tasks, notes and follows after %s removes merged evidence", async (cleanup) => {
        const mail =
            cleanup === "mail retention" || cleanup === "erase mail summary";
        if (!mail) await audioItem();
        const itemId = mail ? "private" : "audio";
        const linked = await itemTask(itemId, "Merged commitment");
        let own = await createPersonalTask(viewer("author"), {
            text: "Own reminder",
        });
        own = await updateTask(viewer("author"), own.id, {
            version: own.version,
            note: "Outcome survives",
        });
        await followTask(viewer("author"), linked.id, true);
        await mergeTaskIntoTask(viewer("author"), linked.id, own.id);
        if (cleanup !== "erase transcript" && cleanup !== "erase audio")
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId,
                    userId: "author",
                    provider: "test",
                    model: "test",
                    summary: encryptText("Summary"),
                });
        expect(
            await db()
                .select()
                .from(taskMentions)
                .where(eq(taskMentions.taskId, own.id)),
        ).toHaveLength(1);
        if (cleanup === "erase transcript" || cleanup === "erase audio") {
            await db()
                .update(chatterItems)
                .set({
                    summaryReapedAt: new Date(),
                    contentReapedAt:
                        cleanup === "erase audio" ? new Date() : null,
                })
                .where(eq(chatterItems.id, itemId));
            if (cleanup === "erase transcript")
                await db()
                    .update(recordings)
                    .set({ audioReapedAt: new Date() })
                    .where(eq(recordings.id, itemId));
        }
        if (cleanup === "summary DELETE") {
            const response = await deleteSummary(
                new Request(
                    `https://example.test/api/recordings/${itemId}/summary`,
                    { method: "DELETE" },
                ),
                { params: Promise.resolve({ id: itemId }) },
            );
            expect(response.status).toBe(200);
        } else if (cleanup === "summary retention") {
            expect(
                await deleteSummaryForRecording(
                    itemId,
                    "author",
                    { isOrg: false, orgUserId: "org" },
                    new Date(),
                ),
            ).toBe(1);
        } else if (cleanup === "mail retention") {
            expect(
                await deleteMailSummaries(
                    itemId,
                    "author",
                    { isOrg: false, orgUserId: "org" },
                    new Date(),
                ),
            ).toBe(1);
        } else if (cleanup === "erase mail summary") {
            await eraseMailSummary("author", itemId);
        } else if (cleanup === "item deletion") {
            await db().transaction(async (tx) => {
                await deleteItemTaskDataInTx(tx, {
                    itemId,
                    ownerUserId: "author",
                    actorUserId: "author",
                    orgUserId: "org",
                    reason: "deleted",
                });
                await tx
                    .delete(chatterItems)
                    .where(eq(chatterItems.id, itemId));
            });
        } else {
            await eraseLocalArtifact(
                "author",
                itemId,
                cleanup === "erase summary"
                    ? "summary"
                    : cleanup === "erase transcript"
                      ? "transcript"
                      : "audio",
            );
        }
        expect(await getCallerTask(viewer("author"), own.id)).toMatchObject({
            text: "Own reminder\nMerged commitment",
            note: own.note,
            noteBy: own.noteBy,
            noteUpdatedAt: own.noteUpdatedAt,
            following: true,
        });
        expect(
            await db()
                .select()
                .from(taskFollowers)
                .where(eq(taskFollowers.taskId, own.id)),
        ).toHaveLength(1);
        expect(
            await db()
                .select()
                .from(taskMentions)
                .where(eq(taskMentions.itemId, itemId)),
        ).toEqual([]);
    });

    it.each([
        "source",
        "target",
        "both",
    ])("preserves note attribution when notes are on %s", async (side) => {
        let target = await itemTask("shared", "Keep");
        let source = await itemTask("other", "Append");
        if (side !== "source")
            target = await updateTask(viewer("assignee"), target.id, {
                version: target.version,
                note: "Kept note",
            });
        if (side !== "target")
            source = await updateTask(viewer("author"), source.id, {
                version: source.version,
                note: "Source note",
            });
        const before = new Date();
        const result = await mergeTaskIntoTask(
            viewer("curator"),
            source.id,
            target.id,
        );
        if (side === "both") {
            expect(result.note).toBe("Kept note\nSource note");
            expect(result.noteBy?.id).toBe("curator");
            expect(
                new Date(result.noteUpdatedAt ?? "").getTime(),
            ).toBeGreaterThanOrEqual(before.getTime());
        } else {
            const original = side === "source" ? source : target;
            expect(result).toMatchObject({
                note: original.note,
                noteBy: original.noteBy,
                noteUpdatedAt: original.noteUpdatedAt,
            });
        }
    });

    it("does not route a later due date or phrase against the accepted merge result", async () => {
        await db()
            .update(chatterItems)
            .set({ userId: "member" })
            .where(eq(chatterItems.id, "other"));
        const target = await addTask(viewer("member"), "other", {
            text: "Keep",
            assigneePersonId: "assigned-person",
            dueDate: "2026-11-10",
            status: "open",
        });
        const source = await itemTask();
        await updateTask(viewer("author"), source.id, {
            version: source.version,
            dueDate: "2026-11-20",
        });
        const result = await mergeTaskIntoTask(
            viewer("assignee"),
            source.id,
            target.id,
        );
        expect(result.dueDate).toBe("2026-11-10");
        const proposals = await db()
            .select()
            .from(taskUpdateProposals)
            .where(eq(taskUpdateProposals.taskId, target.id));
        expect(proposals.map((row) => row.kind)).toEqual(["attach_merge"]);
    });

    it.each([
        true,
        false,
    ])("restores only visible follow preferences without revealing unseen ids (follow=%s)", async (follow) => {
        const hiddenOwn = await createPersonalTask(viewer("member"), {
            text: "Hidden own task",
        });
        await db()
            .insert(chatterItems)
            .values({
                id: "foreign",
                userId: "member",
                kind: "mail",
                title: encryptText("Private"),
                occurredAt: new Date(),
            });
        const hiddenItem = await addTask(viewer("member"), "foreign", {
            text: "Hidden item task",
            status: "open",
        });
        const visible = await itemTask();
        const restore = async (taskId: string) => {
            const response = await restorePost(
                new Request("https://example.test/api/tasks/restore", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        follows: [
                            {
                                taskId,
                                follow,
                                createdAt: "2026-10-01T00:00:00Z",
                            },
                        ],
                    }),
                }),
            );
            expect(response.status).toBe(200);
            return response.json();
        };
        const missing = await restore("unknown");
        expect(await restore(hiddenOwn.id)).toEqual(missing);
        expect(await restore(hiddenItem.id)).toEqual(missing);
        expect(missing).toMatchObject({ follows: 0, skipped: 1 });
        expect(await restore(visible.id)).toMatchObject({
            follows: 1,
            skipped: 0,
        });
        for (const table of [taskFollowers, taskUnfollows]) {
            const rows = await db()
                .select()
                .from(table)
                .where(eq(table.userId, "author"));
            expect(rows.map((row) => row.taskId)).not.toContain(hiddenOwn.id);
            expect(rows.map((row) => row.taskId)).not.toContain(hiddenItem.id);
        }
    });

    it.each([
        [null, "curator", "author"],
        [null, "member", "author"],
        ["private", "assignee", "author"],
        ["private", "curator", "author"],
        ["shared", "member", "author"],
        ["shared", "assignee", "assignee"],
        ["shared", "curator", "curator"],
        ["shared", "author", "author"],
    ])("restores note attribution on %s from %s as %s", async (itemId, claimed, expected) => {
        const archived = {
            id: "restored",
            source: itemId ? "manual" : "personal",
            status: "open",
            text: "Restored",
            note: "Outcome",
            noteUpdatedByUserId: claimed,
            noteUpdatedAt: "2026-10-02T00:00:00Z",
            createdAt: "2026-10-01T00:00:00Z",
            assignee: itemId
                ? { personId: "assigned-person", name: "Luma Veln" }
                : null,
        };
        await restoreTaskArchive(
            viewer("author"),
            itemId
                ? { items: [{ itemId, tasks: [archived] }] }
                : { personal: [archived] },
        );
        expect(
            await getVisibleTask(viewer("author"), archived.id),
        ).toMatchObject({ note: "Outcome", noteBy: { id: expected } });
    });

    it("bounds merge candidate scans to the newest tasks and keeps similarity ranking", async () => {
        const source = await createPersonalTask(viewer("author"), {
            text: "Budget report",
        });
        const stamp = new Date("2026-10-01T00:00:00Z").getTime();
        await db()
            .insert(recordingTasks)
            .values(
                Array.from(
                    { length: MERGE_CANDIDATE_SCAN_LIMIT + 1 },
                    (_, index) => ({
                        id: `candidate-${index}`,
                        userId: "author",
                        source: "personal" as const,
                        status: "open" as const,
                        text: encryptText(
                            index === 0 || index === 1
                                ? "Budget report"
                                : "Miscellaneous reminder",
                        ),
                        createdAt: new Date(stamp + index),
                    }),
                ),
            );
        const page = await searchAssignedMergeCandidates(
            viewer("author"),
            source.id,
            { text: "", offset: 0, limit: MERGE_CANDIDATE_SCAN_LIMIT + 1 },
        );
        expect(page?.candidates).toHaveLength(MERGE_CANDIDATE_SCAN_LIMIT);
        expect(page?.candidates[0].id).toBe("candidate-1");
        expect(page?.candidates.some((row) => row.id === "candidate-0")).toBe(
            false,
        );
    });

    it("previews through GET in a read-only transaction and matches the committed merge", async () => {
        const source = await createPersonalTask(viewer("author"), {
            text: "Private text",
            dueDate: "2026-10-25",
        });
        const target = await itemTask();
        const original = ref.current;
        let preview: Record<string, unknown> = {};
        await db().transaction(
            async (tx) => {
                ref.current = tx as unknown as Record<PropertyKey, unknown>;
                try {
                    const response = await mergeGet(
                        new Request(
                            `https://example.test/api/tasks/${source.id}/merge?target=${target.id}`,
                        ),
                        { params: Promise.resolve({ taskId: source.id }) },
                    );
                    expect(response.status).toBe(200);
                    preview = await response.json();
                } finally {
                    ref.current = original;
                }
            },
            { accessMode: "read only" },
        );
        expect(preview).toMatchObject({
            keepId: target.id,
            mergeId: source.id,
            privateToShared: true,
        });
        expect(await getCallerTask(viewer("author"), source.id)).not.toBeNull();
        const result = await mergeTaskIntoTask(
            viewer("author"),
            source.id,
            target.id,
            { confirmPrivateToShared: true },
        );
        expect(result).toMatchObject({
            id: preview.keepId,
            text: preview.text,
            note: preview.note,
            dueDate: preview.dueDate,
        });
    });

    it("keeps same-item unassigned candidates for a self-assigned item owner alongside cross-item assignments", async () => {
        await db()
            .insert(people)
            .values({
                id: "owner-person",
                userId: "org",
                displayName: encryptText("Owner"),
                primaryEmailHash: lookupHash("author@example.test"),
            });
        const source = await addTask(viewer("author"), "shared", {
            text: "Plan",
            status: "open",
            assigneePersonId: "owner-person",
        });
        const unassigned = await addTask(viewer("author"), "shared", {
            text: "Plan details",
            status: "open",
        });
        const across = await addTask(viewer("author"), "other", {
            text: "Plan follow-up",
            status: "open",
            assigneePersonId: "owner-person",
        });
        const response = await mergeGet(
            new Request(`https://example.test/api/tasks/${source.id}/merge`),
            { params: Promise.resolve({ taskId: source.id }) },
        );
        expect(response.status).toBe(200);
        const page = await response.json();
        expect(page.candidates.map((row: { id: string }) => row.id)).toEqual(
            expect.arrayContaining([unassigned.id, across.id]),
        );
    });

    it.each([
        "member",
        "curator",
    ])("allows %s follow preferences with a read-only Organization and no recording lock", async (id) => {
        await audioItem();
        await db()
            .insert(recordingFolderAssignments)
            .values({ itemId: "audio", userId: "author", folderId: "team" });
        const task = await itemTask("audio");
        vi.mocked(assertOrgScopeWritable).mockImplementation(() => {
            throw new Error("Organization is read-only");
        });
        let unlock: () => void = () => {};
        let locked: () => void = () => {};
        const ready = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const release = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const blocker = db().transaction(async (tx) => {
            await tx
                .select()
                .from(recordings)
                .where(eq(recordings.id, "audio"))
                .for("update");
            locked();
            await release;
        });
        await ready;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const work = async () => {
                expect(
                    (await followTask(viewer(id), task.id, true)).following,
                ).toBe(true);
                expect(
                    (await followTask(viewer(id), task.id, false)).following,
                ).toBe(false);
            };
            await Promise.race([
                work(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "Following waited for the recording lock",
                                ),
                            ),
                        1500,
                    );
                }),
            ]);
            expect(assertOrgScopeWritable).not.toHaveBeenCalled();
        } finally {
            clearTimeout(timer);
            unlock();
            await blocker;
        }
    });

    it.each([
        "assignee",
        "member",
        "curator",
        "org",
    ])("keeps own tasks invisible to %s in lists, detail, search and MCP", async (id) => {
        const own = await createPersonalTask(viewer("author"), {
            text: "Private reminder",
        });
        expect(await list(id, "mine")).toEqual([]);
        expect(await list(id, "followed", true)).toEqual([]);
        expect(await getCallerTask(viewer(id), own.id)).toBeNull();
        expect(
            (await searchTasks(viewer(id), "Private reminder")).hits,
        ).toEqual([]);
        expect((await call("list_tasks", id, { status: "all" })).tasks).toEqual(
            [],
        );
        expect(
            (await call("search_tasks", id, { query: "Private reminder" }))
                .tasks,
        ).toEqual([]);
        await expect(
            followTask(viewer(id), own.id, true),
        ).rejects.toMatchObject({ statusCode: id === "org" ? 403 : 404 });
        const visible = await itemTask();
        await expect(
            previewTaskMerge(viewer(id), own.id, visible.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("includes own tasks only on Mine and All folders, supports edits, drop and restore, and raises no badge", async () => {
        let own = await createPersonalTask(viewer("author"), {
            text: "Reminder",
            dueDate: "2026-10-25",
        });
        expect((await list("author", "mine")).map((task) => task.id)).toEqual([
            own.id,
        ]);
        expect(await list("author", "mine", false, "team")).toEqual([]);
        expect(await countNewTasks(viewer("author"))).toBe(0);
        own = await updateTask(viewer("author"), own.id, {
            version: own.version,
            text: "Edited reminder",
            dueDate: null,
            status: "dropped",
        });
        own = await updateTask(viewer("author"), own.id, {
            version: own.version,
            status: "open",
        });
        expect(own).toMatchObject({
            recordingId: null,
            source: "personal",
            text: "Edited reminder",
            dueDate: null,
            status: "open",
            canMerge: true,
        });
        await expect(
            updateTask(viewer("author"), own.id, {
                version: own.version,
                assigneePersonId: null,
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const linked = await itemTask("private", "Private source");
        await mergeTaskIntoTask(viewer("author"), linked.id, own.id);
        await db().transaction((tx) =>
            deleteItemTaskDataInTx(tx, {
                itemId: "private",
                ownerUserId: "author",
                actorUserId: "author",
                orgUserId: "org",
                reason: "erased",
            }),
        );
        expect(await getCallerTask(viewer("author"), own.id)).not.toBeNull();
    });
    it.each([
        "private",
        "shared",
    ])("enforces the role table on %s items", async (itemId) => {
        const task = await itemTask(itemId);
        for (const id of ["author", "assignee", "member", "curator", "org"]) {
            const visible = id === "author" || itemId === "shared";
            const closes =
                id === "author" ||
                (itemId === "shared" &&
                    ["assignee", "curator", "org"].includes(id));
            const edits =
                id === "author" ||
                (itemId === "shared" && ["curator", "org"].includes(id));
            const value = await getVisibleTask(viewer(id), task.id);
            expect(Boolean(value), id).toBe(visible);
            if (visible)
                expect(value).toMatchObject({
                    canClose: closes,
                    canEdit: edits,
                    canMerge: closes,
                    canFollow: id !== "org",
                });
            if (!closes)
                await expect(
                    updateTask(viewer(id), task.id, {
                        version: 0,
                        note: "Refused",
                    }),
                ).rejects.toMatchObject({ statusCode: visible ? 403 : 404 });
            if (!edits)
                await expect(
                    updateTask(viewer(id), task.id, {
                        version: 0,
                        text: "Refused",
                    }),
                ).rejects.toMatchObject({ statusCode: visible ? 403 : 404 });
        }
    });
    it("combines explicit and automatic follows, unfollows, curator scope and tracked alias", async () => {
        const task = await itemTask();
        expect(
            (await list("author", "followed")).map((task) => task.id),
        ).toEqual([task.id]);
        expect(await list("member", "followed")).toEqual([]);
        expect(await list("curator", "followed")).toEqual([]);
        expect(
            (await list("curator", "followed", true)).map((task) => task.id),
        ).toEqual([task.id]);
        await followTask(viewer("member"), task.id, true);
        await followTask(viewer("member"), task.id, true);
        expect(await list("member", "tracked")).toEqual(
            await list("member", "followed"),
        );
        expect(await getCallerTask(viewer("member"), task.id)).not.toBeNull();
        await followTask(viewer("author"), task.id, false);
        expect(await list("author", "followed")).toEqual([]);
        await db()
            .delete(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "shared"));
        expect(await list("member", "followed")).toEqual([]);
        expect(await getCallerTask(viewer("member"), task.id)).toBeNull();
        expect(
            await followsForArchive({ kind: "personal", userId: "member" }),
        ).toHaveLength(1);
        await db()
            .insert(recordingFolderAssignments)
            .values({ itemId: "shared", userId: "author", folderId: "team" });
        expect(
            (await list("member", "followed")).map((task) => task.id),
        ).toEqual([task.id]);
        await followTask(viewer("member"), task.id, false);
        expect(await list("member", "followed")).toEqual([]);
    });
    it("writes and replaces an encrypted note on close and later, with who and when, and never prompts it", async () => {
        let task = await itemTask();
        task = await updateTask(viewer("assignee"), task.id, {
            version: task.version,
            status: "done",
            note: "Unique note sentinel",
        });
        expect(task).toMatchObject({
            note: "Unique note sentinel",
            noteBy: { id: "assignee", name: "assignee" },
        });
        expect(task.noteUpdatedAt).toBeTruthy();
        const [stored] = await db()
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.id, task.id));
        expect(stored.note).not.toBe(task.note);
        expect(decryptText(stored.note ?? "")).toBe(task.note);
        task = await updateTask(viewer("curator"), task.id, {
            version: task.version,
            note: "Replacement",
        });
        expect(task).toMatchObject({
            note: "Replacement",
            noteBy: { id: "curator" },
        });
        const prompt = await loadTasksPromptContext({
            recording: {
                id: "shared",
                userId: "author",
                occurredAt: new Date(),
                timezone: null,
                zonemins: null,
            },
            transcriptionId: null,
            orgView: true,
            reviewer: viewer("author"),
        });
        expect(prompt.text).not.toContain("Replacement");
        expect(
            (await searchTasks(viewer("author"), "Replacement")).hits.map(
                (hit) => hit.id,
            ),
        ).toEqual([task.id]);
        task = await updateTask(viewer("assignee"), task.id, {
            version: task.version,
            note: null,
        });
        expect(task.note).toBeNull();
    });
    it("accepts 2000-character text and notes, refusing longer content and invalid dates", async () => {
        const task = await createPersonalTask(viewer("author"), {
            text: "x".repeat(2000),
        });
        expect(
            (
                await updateTask(viewer("author"), task.id, {
                    version: task.version,
                    note: "n".repeat(2000),
                })
            ).note,
        ).toHaveLength(2000);
        await expect(
            createPersonalTask(viewer("author"), { text: "x".repeat(2001) }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            updateTask(viewer("author"), task.id, {
                version: 1,
                note: "n".repeat(2001),
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            createPersonalTask(viewer("author"), {
                text: "Date",
                dueDate: "2026-02-30",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });
    it("merges as assignee across items with preview, text, notes, earlier date, mentions and followers", async () => {
        let keep = await itemTask("shared", "Keep first");
        let merge = await itemTask("other", "Append second");
        keep = await updateTask(viewer("author"), keep.id, {
            version: keep.version,
            note: "First note",
            dueDate: "2026-10-29",
        });
        merge = await updateTask(viewer("author"), merge.id, {
            version: merge.version,
            note: "Second note",
            dueDate: "2026-10-25",
        });
        await followTask(viewer("member"), merge.id, true);
        await followTask(viewer("curator"), keep.id, true);
        const candidates = await searchAssignedMergeCandidates(
            viewer("assignee"),
            merge.id,
            { text: "", offset: 0, limit: 20 },
        );
        expect(candidates?.candidates.map((task) => task.id)).toContain(
            keep.id,
        );
        const preview = await previewTaskMerge(
            viewer("assignee"),
            merge.id,
            keep.id,
        );
        expect(preview).toMatchObject({
            text: "Keep first\nAppend second",
            note: "First note\nSecond note",
            dueDate: "2026-10-25",
        });
        expect(
            await getVisibleTask(viewer("assignee"), merge.id),
        ).not.toBeNull();
        const result = await mergeTaskIntoTask(
            viewer("assignee"),
            merge.id,
            keep.id,
            { sourceVersion: merge.version, targetVersion: keep.version },
        );
        expect(result).toMatchObject({
            text: "Keep first\nAppend second",
            note: "First note\nSecond note",
            dueDate: "2026-10-25",
        });
        expect(
            await db()
                .select()
                .from(taskMentions)
                .where(eq(taskMentions.taskId, keep.id)),
        ).toHaveLength(2);
        expect(
            await db()
                .select()
                .from(taskFollowers)
                .where(eq(taskFollowers.taskId, keep.id)),
        ).toHaveLength(3);
    });
    it.each([
        true,
        false,
    ])("preserves an automatic source follower across owners unless unfollowed (%s)", async (following) => {
        await db()
            .update(chatterItems)
            .set({ userId: "member" })
            .where(eq(chatterItems.id, "other"));
        const keep = await addTask(viewer("member"), "other", {
            text: "Keep",
            assigneePersonId: "assigned-person",
            status: "open",
        });
        const source = await itemTask();
        if (!following) await followTask(viewer("author"), source.id, false);
        await followTask(viewer("author"), keep.id, false);
        await mergeTaskIntoTask(viewer("assignee"), source.id, keep.id);
        expect(
            (await list("author", "followed")).map((task) => task.id),
        ).toEqual(following ? [keep.id] : []);
    });
    it("redacts a merged mail note even when the kept home and newest evidence are audio", async () => {
        await db()
            .insert(chatterItems)
            .values({
                id: "audio",
                userId: "author",
                kind: "audio",
                title: encryptText("Audio"),
                occurredAt: new Date("2026-10-20T10:00:00Z"),
            });
        await db()
            .insert(recordingFolderAssignments)
            .values({ itemId: "audio", userId: "author", folderId: "team" });
        await db()
            .insert(recordings)
            .values({
                id: "audio",
                userId: "author",
                deviceSn: "browser",
                plaudFileId: "audio",
                duration: 1000,
                endTime: new Date("2026-10-20T10:00:01Z"),
                filesize: 100,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "audio.wav",
                plaudVersion: "1",
            });
        const keep = await itemTask("audio", "Audio task");
        const source = await itemTask();
        await updateTask(viewer("assignee"), source.id, {
            version: source.version,
            note: "Older mail note sentinel",
        });
        await mergeTaskIntoTask(viewer("assignee"), source.id, keep.id);
        expect(
            (await getVisibleTask(viewer("assignee"), keep.id))?.recording
                ?.kind,
        ).toBe("audio");
        const withoutMail = await call("list_tasks", "assignee", {
            list: "mine",
        });
        expect(withoutMail.tasks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: keep.id,
                    note: null,
                    note_by: null,
                    note_updated_at: null,
                }),
            ]),
        );
        expect(
            (
                await call("search_tasks", "assignee", {
                    query: "Older mail note sentinel",
                })
            ).tasks,
        ).toEqual([]);
        expect(
            (
                await call(
                    "search_tasks",
                    "assignee",
                    { query: "Older mail note sentinel" },
                    true,
                )
            ).tasks,
        ).toHaveLength(1);
    });
    it("always keeps the Organization task and requires private disclosure confirmation and current versions", async () => {
        const shared = await itemTask();
        const own = await createPersonalTask(viewer("assignee"), {
            text: "Private addition",
        });
        const preview = await previewTaskMerge(
            viewer("assignee"),
            shared.id,
            own.id,
        );
        expect(preview).toMatchObject({
            keepId: shared.id,
            mergeId: own.id,
            privateToShared: true,
        });
        await expect(
            mergeTaskIntoTask(viewer("assignee"), own.id, shared.id),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            mergeTaskIntoTask(viewer("assignee"), own.id, shared.id, {
                confirmPrivateToShared: true,
                sourceVersion: 99,
                targetVersion: 0,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const result = await mergeTaskIntoTask(
            viewer("assignee"),
            shared.id,
            own.id,
            {
                confirmPrivateToShared: true,
                sourceVersion: shared.version,
                targetVersion: own.version,
            },
        );
        expect(result.id).toBe(shared.id);
        expect(
            (await getVisibleTask(viewer("member"), shared.id))?.text,
        ).toContain("Private addition");
    });
    it("refuses non-open, overlong and unauthorized merges without changing tasks", async () => {
        const a = await createPersonalTask(viewer("author"), {
            text: "x".repeat(1500),
        });
        const b = await createPersonalTask(viewer("author"), {
            text: "y".repeat(1500),
        });
        await expect(
            mergeTaskIntoTask(viewer("author"), a.id, b.id),
        ).rejects.toMatchObject({ statusCode: 400 });
        await updateTask(viewer("author"), a.id, {
            version: 0,
            status: "done",
        });
        await expect(
            mergeTaskIntoTask(viewer("author"), a.id, b.id),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            mergeTaskIntoTask(viewer("member"), a.id, b.id),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
    it("keeps the badge unchanged by own tasks, follows and note changes", async () => {
        const task = await itemTask();
        const before = await countNewTasks(viewer("member"));
        await createPersonalTask(viewer("member"), { text: "No badge" });
        await followTask(viewer("member"), task.id, true);
        await updateTask(viewer("assignee"), task.id, {
            version: 0,
            note: "Progress",
        });
        expect(await countNewTasks(viewer("member"))).toBe(before);
    });
    it("round trips own tasks, item notes, follows and unfollows, excluding them from the Organization archive", async () => {
        let own = await createPersonalTask(viewer("author"), {
            text: "Own backup",
            dueDate: "2026-10-30",
        });
        own = await updateTask(viewer("author"), own.id, {
            version: own.version,
            note: "Own note",
        });
        const task = await itemTask();
        await updateTask(viewer("author"), task.id, {
            version: 0,
            note: "Shared note",
        });
        await followTask(viewer("author"), task.id, false);
        await followTask(viewer("author"), own.id, true);
        const personal = await personalTasksForArchive({
            kind: "personal",
            userId: "author",
        });
        const follows = await followsForArchive({
            kind: "personal",
            userId: "author",
        });
        const itemNotes = await tasksForArchive(
            { kind: "personal", userId: "author" },
            ["shared"],
            { proposals: true },
        );
        expect(itemNotes.get("shared")?.[0].note).toBe("Shared note");
        expect(
            await personalTasksForArchive({
                kind: "organization",
                orgUserId: "org",
            }),
        ).toEqual([]);
        expect(
            await followsForArchive({ kind: "organization", orgUserId: "org" }),
        ).toEqual([]);
        await db()
            .delete(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.id, own.id),
                    eq(recordingTasks.userId, "author"),
                ),
            );
        await db()
            .delete(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.id, task.id),
                    eq(recordingTasks.userId, "author"),
                ),
            );
        await db()
            .delete(taskUnfollows)
            .where(eq(taskUnfollows.userId, "author"));
        expect(
            await restoreTaskArchive(viewer("author"), {
                personal,
                items: [{ itemId: "shared", tasks: itemNotes.get("shared") }],
                follows,
            }),
        ).toMatchObject({ tasks: 2, follows: 2 });
        expect(await getCallerTask(viewer("author"), own.id)).toMatchObject({
            text: "Own backup",
            note: "Own note",
            dueDate: "2026-10-30",
            noteBy: { id: "author" },
        });
        expect((await getVisibleTask(viewer("author"), task.id))?.note).toBe(
            "Shared note",
        );
        expect(
            await followsForArchive({ kind: "personal", userId: "author" }),
        ).toEqual(follows);
        await expect(
            restoreTaskArchive(viewer("org"), { personal }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
    it("puts the personal task and follows files into the backup ZIP with manifest paths", async () => {
        const task = await createPersonalTask(viewer("author"), {
            text: "ZIP own task",
        });
        await followTask(viewer("author"), task.id, true);
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
        expect(zip.files.map((file) => file.path)).toEqual(
            expect.arrayContaining([
                "tasks/personal.json",
                "tasks/follows.json",
                "manifest.json",
            ]),
        );
        const file = zip.files.find(
            (file) => file.path === "tasks/personal.json",
        );
        expect(
            JSON.parse((await file?.buffer())?.toString() ?? "[]")[0],
        ).toMatchObject({ id: task.id, text: "ZIP own task" });
    });
    it("describes every new update input and flags irreversible replacements", () => {
        const update = TASK_TOOLS.find((tool) => tool.name === "update_task");
        const list = TASK_TOOLS.find((tool) => tool.name === "list_tasks");
        if (!update || !list) throw new Error("Missing task tools");
        expect(update.annotations.destructiveHint).toBe(true);
        const schema = z.toJSONSchema(
            z.object(update.input(caller("author"))),
            { io: "input" },
        );
        for (const field of [
            "status",
            "assignee",
            "text",
            "due_date",
            "note",
            "folder",
        ]) {
            const property = schema.properties?.[field];
            expect(
                typeof property === "object" && property.description,
            ).toBeTruthy();
        }
        expect(update.description).toContain("cannot be undone");
        expect(list.description).toContain("own tasks");
        expect(list.description).toContain("folder");
    });
    it("supports all MCP task operations, schemas and annotations with mail-note redaction", async () => {
        const made = await call("create_task", "assignee", {
            text: "MCP own task",
            due_date: "2026-10-28",
        });
        const own = made.task as { id: string; version: number };
        expect(made.task).toMatchObject({ own: true, can_merge: true });
        const updated = await call("update_task", "assignee", {
            task: own.id,
            version: own.version,
            text: "Revised",
            due_date: null,
            note: "MCP note",
        });
        expect(updated.task).toMatchObject({
            text: "Revised",
            note: "MCP note",
            due_date: null,
        });
        expect(
            (await call("list_tasks", "assignee", { list: "mine" })).tasks,
        ).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: own.id })]),
        );
        const shared = await itemTask();
        await call("follow_task", "member", { task: shared.id, follow: true });
        expect(
            (await call("list_tasks", "member", { list: "followed" })).tasks,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: shared.id, following: true }),
            ]),
        );
        await call("follow_task", "member", { task: shared.id, follow: false });
        await updateTask(viewer("assignee"), shared.id, {
            version: 0,
            note: "Mailbox sentinel",
        });
        expect(
            (
                await call("search_tasks", "assignee", {
                    query: "Mailbox sentinel",
                })
            ).tasks,
        ).toEqual([]);
        expect(
            (
                await call(
                    "search_tasks",
                    "assignee",
                    { query: "Mailbox sentinel" },
                    true,
                )
            ).tasks,
        ).toHaveLength(1);
        await expect(
            call("create_task", "org", { text: "Refuse" }),
        ).rejects.toMatchObject({ outcome: "denied" });
        const merged = await call(
            "merge_tasks",
            "assignee",
            {
                keep: shared.id,
                merge: own.id,
                keep_version: 1,
                merge_version: 1,
                confirm_private_to_shared: true,
            },
            true,
        );
        expect(merged.task).toMatchObject({
            id: shared.id,
            text: "Send the revised plan\nRevised",
        });
        for (const tool of TASK_TOOLS) {
            expect(tool.annotations.readOnlyHint).toBe(
                tool.name === "list_tasks" || tool.name === "search_tasks",
            );
            expect(tool.anyOf).toEqual([
                tool.annotations.readOnlyHint ? "tasks:read" : "tasks:write",
            ]);
        }
        expect(
            TASK_TOOLS.find((tool) => tool.name === "merge_tasks")?.annotations
                .destructiveHint,
        ).toBe(true);
    });
});
