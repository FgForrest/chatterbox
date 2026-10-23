import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import {
    chatterItems,
    mcpAccessLog,
    recordingFolderAssignments,
    recordingTasks,
    taskMentions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    return {
        dbRef: ref,
        dbProxy: new Proxy(
            {},
            {
                get: (_target, property) => {
                    const current = ref.current;
                    if (!current)
                        throw new Error("test database was not initialized");
                    const value = current[property];
                    return typeof value === "function"
                        ? value.bind(current)
                        : value;
                },
            },
        ),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            APP_URL: "https://chatterbox.example.com",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn(),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn(),
    exportRecordingSidecarsIfEnabled: vi.fn(),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));

import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import { buildMcpServer } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { TASK_TOOLS } from "@/lib/mcp/tools/tasks";
import { ensureOrgAccount } from "@/lib/org/account";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    insertPerson,
    insertRecording,
    insertTask,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const WRITER: McpRole[] = ["tasks:read", "tasks:write"];

interface TaskOut {
    id: string;
    status: string;
    version: number;
    note: string | null;
    note_by: { id: string; name: string | null } | null;
    note_updated_at: string | null;
}

function resultTask(result: CallToolResult): TaskOut {
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as unknown as { task: TaskOut }).task;
}

function errorBody(result: CallToolResult) {
    expect(result.isError).toBe(true);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("missing error text");
    return JSON.parse(content.text) as {
        error: string;
        details?: { current: TaskOut };
    };
}

describeWithDatabase("MCP task notes (PostgreSQL)", () => {
    let database: TestPostgresDatabase;
    let orgUserId: string;
    let assigneeId: string;
    let taskId: string;
    const sessions: { client: Client; close: () => Promise<void> }[] = [];

    function db() {
        return database.db;
    }
    const owner = (roles = WRITER) =>
        userCaller("author", "author@example.test", roles, orgUserId);
    const assignee = (roles = WRITER) =>
        userCaller("assignee", "assignee@example.test", roles, orgUserId);

    async function connect(caller: McpCaller) {
        const server = buildMcpServer(TASK_TOOLS, caller, null);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: "test", version: "1" });
        await client.connect(clientSide);
        const session = {
            client,
            close: async () => {
                await client.close();
                await server.close();
            },
        };
        sessions.push(session);
        return client;
    }
    async function update(caller: McpCaller, args: Record<string, unknown>) {
        const client = await connect(caller);
        return (await client.callTool({
            name: "update_task",
            arguments: { task: taskId, version: 0, ...args },
        })) as CallToolResult;
    }
    async function stored(id = taskId) {
        const [row] = await db()
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.id, id));
        if (!row) throw new Error("missing task");
        return row;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_task_notes",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: "author", email: "author@example.test", name: "Author" },
                {
                    id: "assignee",
                    email: "assignee@example.test",
                    name: "Assignee",
                },
                { id: "observer", email: "observer@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("missing Organization");
        await insertRecording(db(), { id: "shared", userId: "author" });
        await shareRecording(db(), "shared", orgUserId);
        assigneeId = await insertPerson(db(), orgUserId, "Assignee", {
            emailHash: lookupHash("assignee@example.test"),
        });
        await db()
            .insert(chatterItems)
            .values({
                id: "mail",
                userId: "author",
                kind: "mail",
                title: encryptText("Mail"),
                occurredAt: new Date(),
            });
        const [filing] = await db()
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, "shared"));
        if (!filing) throw new Error("missing filing");
        await db().insert(recordingFolderAssignments).values({
            itemId: "mail",
            userId: "author",
            folderId: filing.folderId,
        });
    }, 120_000);

    beforeEach(async () => {
        for (const session of sessions.splice(0)) await session.close();
        await db().delete(recordingTasks);
        await db().delete(mcpAccessLog);
        vi.mocked(notifyIfShared).mockClear();
        taskId = await insertTask(db(), {
            recordingId: "shared",
            userId: "author",
            assigneePersonId: assigneeId,
        });
    });

    afterAll(async () => {
        for (const session of sessions) await session.close();
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("sets, trims and replaces the encrypted note as the assignee, with writer and time", async () => {
        const started = Date.now();
        const first = resultTask(
            await update(assignee(), { note: "  Shipped in release X.  " }),
        );
        expect(first).toMatchObject({
            note: "Shipped in release X.",
            note_by: { id: "assignee", name: "Assignee" },
            version: 1,
        });
        const row = await stored();
        expect(row.note).not.toBe(first.note);
        expect(decryptText(row.note ?? "")).toBe(first.note);
        expect(row.noteUpdatedByUserId).toBe("assignee");
        expect(row.noteUpdatedAt?.getTime()).toBeGreaterThanOrEqual(started);
        expect(first.note_updated_at).toBe(row.noteUpdatedAt?.toISOString());
        const next = resultTask(
            await update(owner(), { version: 1, note: "Replacement" }),
        );
        expect(next).toMatchObject({
            note: "Replacement",
            note_by: { id: "author" },
            version: 2,
        });
        expect(vi.mocked(notifyIfShared)).toHaveBeenCalledWith("shared");
    });

    it.each([
        null,
        "",
        " \n\t ",
    ])("clears a note with %j, retaining caller attribution", async (note) => {
        resultTask(await update(owner(), { note: "Previous" }));
        const cleared = resultTask(
            await update(assignee(), { version: 1, note }),
        );
        expect(cleared).toMatchObject({
            note: null,
            note_by: { id: "assignee" },
            version: 2,
        });
        expect((await stored()).note).toBeNull();
        expect(cleared.note_updated_at).toBeTruthy();
    });

    it("combines status, assignee and note under one version", async () => {
        const updated = resultTask(
            await update(owner(), {
                status: "done",
                assignee: null,
                note: "Delivered",
            }),
        );
        expect(updated).toMatchObject({
            status: "done",
            note: "Delivered",
            version: 1,
        });
        expect(await stored()).toMatchObject({
            assigneePersonId: null,
            statusChangedByUserId: "author",
            noteUpdatedByUserId: "author",
            version: 1,
        });
    });

    it("lets an assignee complete with a note but refuses reassignment without saving either change", async () => {
        const before = await stored();
        expect(
            errorBody(
                await update(assignee(), {
                    status: "done",
                    assignee: null,
                    note: "Refused together",
                }),
            ).error,
        ).toBe("Not allowed to change this task");
        expect(await stored()).toEqual(before);
        expect(
            resultTask(
                await update(assignee(), { status: "done", note: "Delivered" }),
            ),
        ).toMatchObject({ status: "done", note: "Delivered", version: 1 });
    });

    it("changes nothing on a version conflict and returns the current note", async () => {
        resultTask(await update(owner(), { note: "Keep this" }));
        const before = await stored();
        const error = errorBody(
            await update(owner(), {
                status: "done",
                assignee: null,
                note: "Lost update",
            }),
        );
        expect(error.details?.current).toMatchObject({
            status: "open",
            note: "Keep this",
            version: 1,
        });
        expect(await stored()).toEqual(before);
    });

    it("refuses a listed follower without can_close, including a combined status change", async () => {
        const observer = userCaller(
            "observer",
            "observer@example.test",
            WRITER,
            orgUserId,
        );
        const client = await connect(observer);
        await client.callTool({
            name: "follow_task",
            arguments: { task: taskId, follow: true },
        });
        const before = await stored();
        expect(
            errorBody(
                await update(observer, { note: "Refused", status: "done" }),
            ).error,
        ).toBe("Not allowed to change this task");
        expect(await stored()).toEqual(before);
    });

    it.each([
        "Overwrite",
        null,
        "",
    ])("refuses %j on a mail note without mail:read and preserves the whole task", async (note) => {
        taskId = await insertTask(db(), {
            recordingId: "mail",
            userId: "author",
            assigneePersonId: assigneeId,
        });
        resultTask(
            await update(owner([...WRITER, "mail:read"]), {
                note: "Mail outcome",
            }),
        );
        const before = await stored();
        expect(
            errorBody(
                await update(assignee(), { version: 1, status: "done", note }),
            ).error,
        ).toContain("mail:read");
        expect(await stored()).toEqual(before);
    });

    it("allows a mail note with mail:read, redacts reads and conflicts without it, and still permits status-only updates", async () => {
        taskId = await insertTask(db(), {
            recordingId: "mail",
            userId: "author",
            assigneePersonId: assigneeId,
        });
        const saved = resultTask(
            await update(assignee([...WRITER, "mail:read"]), {
                note: "Mail outcome",
            }),
        );
        expect(saved.note).toBe("Mail outcome");
        const closed = resultTask(
            await update(assignee(), { version: 1, status: "done" }),
        );
        expect(closed).toMatchObject({
            status: "done",
            note: null,
            note_by: null,
            note_updated_at: null,
        });
        const stale = errorBody(
            await update(assignee(), { version: 1, status: "open" }),
        );
        expect(stale.details?.current).toMatchObject({
            note: null,
            note_by: null,
            note_updated_at: null,
        });
        const cleared = resultTask(
            await update(assignee([...WRITER, "mail:read"]), {
                version: 2,
                note: null,
            }),
        );
        expect(cleared.note).toBeNull();
    });

    it("protects an audio task's mail-sourced note even when the mail mention is hidden", async () => {
        await db().insert(taskMentions).values({
            taskId,
            itemId: "mail",
            userId: "author",
            view: "private",
            statementAt: new Date(),
            matchDecision: "accepted",
        });
        expect(
            errorBody(await update(assignee(), { note: "Refused" })).error,
        ).toContain("mail:read");
        expect(
            resultTask(
                await update(assignee([...WRITER, "mail:read"]), {
                    note: "Allowed",
                }),
            ).note,
        ).toBe("Allowed");
    });

    it("accepts 2000 characters after trimming and rejects 2001 without any mutation", async () => {
        const note = "n".repeat(2000);
        expect(
            resultTask(await update(owner(), { note: `  ${note}  ` })).note,
        ).toBe(note);
        const before = await stored();
        expect(
            errorBody(
                await update(owner(), {
                    version: 1,
                    status: "done",
                    note: `${note}n`,
                }),
            ).error,
        ).toBe("Invalid arguments");
        expect(await stored()).toEqual(before);
    });

    it("finds the newly written note through search_tasks", async () => {
        resultTask(await update(assignee(), { note: "Zephyr shipment" }));
        const client = await connect(assignee());
        const found = await client.callTool({
            name: "search_tasks",
            arguments: { query: "zephyr" },
        });
        expect(found.structuredContent).toMatchObject({
            tasks: [
                expect.objectContaining({
                    id: taskId,
                    note: "Zephyr shipment",
                }),
            ],
        });
    });

    it("audits a note-only write with task and caller identifiers, never its text", async () => {
        resultTask(
            await update(assignee(), { note: "Private outcome sentinel" }),
        );
        const rows = await db().select().from(mcpAccessLog);
        expect(rows).toEqual([
            expect.objectContaining({
                tool: "update_task",
                outcome: "ok",
                userId: "assignee",
                subject: "assignee-sub",
                clientId: "test-client",
                targetIds: [taskId],
            }),
        ]);
        expect(JSON.stringify(rows)).not.toContain("Private outcome sentinel");
    });

    it("writes as a service account under the existing shared-task permissions", async () => {
        const saved = resultTask(
            await update(serviceCaller(orgUserId, WRITER), {
                note: "Service outcome",
            }),
        );
        expect(saved.note_by?.id).toBe(orgUserId);
        const [log] = await db().select().from(mcpAccessLog);
        expect(log).toMatchObject({
            callerKind: "service",
            userId: null,
            clientId: "test-bot",
            outcome: "ok",
        });
    });

    it("permits own-task notes only to the author", async () => {
        const client = await connect(owner());
        const own = resultTask(
            (await client.callTool({
                name: "create_task",
                arguments: { text: "Private reminder" },
            })) as CallToolResult,
        );
        taskId = own.id;
        const before = await stored();
        for (const caller of [assignee(), serviceCaller(orgUserId, WRITER)]) {
            expect(
                errorBody(await update(caller, { note: "Refused" })).error,
            ).toBe("Not found");
        }
        expect(await stored()).toEqual(before);
        const saved = resultTask(
            await update(owner(), { note: "Author outcome" }),
        );
        expect(saved).toMatchObject({
            note: "Author outcome",
            note_by: { id: "author" },
        });
    });

    it.each([
        false,
        true,
    ])("writes own-task notes without Organization scope (hosted=%s)", async (hosted) => {
        mockEnv.IS_HOSTED = hosted;
        mockEnv.SELF_HOST_MODE = "local";
        try {
            const client = await connect(
                userCaller("author", "author@example.test", WRITER, null),
            );
            const own = resultTask(
                (await client.callTool({
                    name: "create_task",
                    arguments: { text: "Private reminder" },
                })) as CallToolResult,
            );
            taskId = own.id;
            expect(
                resultTask(
                    await update(
                        userCaller(
                            "author",
                            "author@example.test",
                            WRITER,
                            null,
                        ),
                        { note: "Private outcome" },
                    ),
                ),
            ).toMatchObject({
                note: "Private outcome",
                note_by: { id: "author" },
            });
        } finally {
            mockEnv.IS_HOSTED = false;
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });

    it("refuses a note-only call without tasks:write and an empty change", async () => {
        const before = await stored();
        expect(
            errorBody(await update(owner(["tasks:read"]), { note: "Refused" }))
                .error,
        ).toBe("Unknown tool");
        expect(errorBody(await update(owner(), {})).error).toContain(
            "Give a status",
        );
        expect(await stored()).toEqual(before);
    });
});
