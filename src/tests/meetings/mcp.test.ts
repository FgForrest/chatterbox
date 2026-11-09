import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));
vi.mock("@/lib/mcp/scope", () => ({
    mayReadMail: (caller: { roles: Set<string> }) =>
        caller.roles.has("mail:read"),
}));
const service = vi.hoisted(() => ({
    list: vi.fn(),
    get: vi.fn(),
    prepare: vi.fn(),
    add: vi.fn(),
    change: vi.fn(),
    addTask: vi.fn(),
    changeTask: vi.fn(),
    mail: vi.fn(),
    patch: vi.fn(),
    reorder: vi.fn(),
    decide: vi.fn(),
    dismiss: vi.fn(),
    enqueue: vi.fn(),
    visibleTask: vi.fn(),
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewerById: async (userId: string) => ({ userId }),
}));
vi.mock("@/lib/tasks/tasks", () => ({ getVisibleTask: service.visibleTask }));
vi.mock("@/lib/meetings/access", () => ({ requireMeetingAccess: vi.fn() }));
vi.mock("@/db/queries/agenda-mail-sources", () => ({
    agendaMailDerivedContent: service.mail,
}));
vi.mock("@/lib/meetings/service", () => ({
    listMeetings: service.list,
    getMeeting: service.get,
    prepareMeeting: service.prepare,
    addPoint: service.add,
    changePoint: service.change,
    addAgendaTask: service.addTask,
    changeAgendaTask: service.changeTask,
    patchMeeting: service.patch,
    reorderAgendaTasks: service.reorder,
    decideSuggestion: service.decide,
}));

vi.mock("@/lib/meetings/dismiss-suggestions", () => ({
    dismissSuggestions: service.dismiss,
}));
vi.mock("@/lib/meetings/suggestions-job", () => ({
    enqueueAgendaSuggestions: service.enqueue,
}));

import { AppError, ErrorCode } from "@/lib/errors";
import type { McpCaller } from "@/lib/mcp/caller";
import { allowedTools } from "@/lib/mcp/registry";
import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";

const caller: McpCaller = {
    kind: "user",
    userId: "owner",
    email: "owner@example.com",
    subject: "owner",
    clientId: "test",
    orgUserId: "org",
    roles: new Set(["tasks:read", "tasks:write"]),
};
async function run(
    name: string,
    input: Record<string, unknown>,
    principal = caller,
) {
    const tool = MEETING_TOOLS.find((entry) => entry.name === name);
    if (!tool) throw new Error("Tool missing");
    return tool.run(
        { caller: principal, touched: [] },
        z.object(tool.input(principal)).parse(input),
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    service.visibleTask.mockResolvedValue({ id: "task" });
    service.mail.mockResolvedValue({
        suggestionIds: new Set(),
        pointIds: new Set(),
    });
    service.list.mockResolvedValue([{ id: "agenda", folders: [] }]);
    service.get.mockResolvedValue({
        unchanged: false,
        taskGroupOrder: [],
        points: [],
        suggestions: [],
        id: "agenda",
        tasks: [],
        invitees: [],
        taskGroups: [],
    });
    service.prepare.mockResolvedValue({ id: "agenda", existing: false });
});

describe("meeting MCP tools", () => {
    it("annotates read-only tools and uses the existing task write role", () => {
        expect(
            MEETING_TOOLS.slice(0, 2).every(
                (tool) => tool.annotations.readOnlyHint,
            ),
        ).toBe(true);
        expect(
            allowedTools(MEETING_TOOLS, {
                ...caller,
                roles: new Set(["tasks:read"]),
            }).map((tool) => tool.name),
        ).toEqual(["list_meetings", "get_meeting"]);
    });
    it("scopes service reads to the Organization context", async () => {
        await run(
            "list_meetings",
            {},
            {
                kind: "service",
                orgUserId: "org",
                subject: "service",
                clientId: "test",
                roles: new Set(["tasks:read"]),
            },
        );
        expect(service.list).toHaveBeenCalledWith("org", {});
    });
    it("returns an existing agenda on prepare", async () => {
        service.prepare.mockResolvedValue({ id: "agenda", existing: true });
        expect(
            await run("prepare_meeting", { folderId: "folder", title: "Acme" }),
        ).toMatchObject({ id: "agenda", existing: true });
        expect(service.prepare).toHaveBeenCalledWith("owner", {
            folderId: "folder",
            title: "Acme",
        });
    });
    it("applies point operations with versions and shared service checks", async () => {
        await run("edit_agenda", {
            meetingId: "agenda",
            operations: [
                {
                    action: "update_point",
                    pointId: "point",
                    text: "New",
                    version: 2,
                },
                { action: "add_task", taskId: "task" },
            ],
        });
        expect(service.change).toHaveBeenCalledWith(
            "owner",
            "agenda",
            "point",
            expect.objectContaining({ text: "New", version: 2 }),
        );
        expect(service.addTask).toHaveBeenCalledWith("owner", "agenda", "task");
    });
    it("returns a permission refusal with the completed-operation count", async () => {
        service.addTask.mockRejectedValueOnce(
            new AppError(ErrorCode.FORBIDDEN, "Forbidden", 403),
        );
        await expect(
            run("edit_agenda", {
                meetingId: "agenda",
                operations: [{ action: "add_task", taskId: "task" }],
            }),
        ).rejects.toMatchObject({
            outcome: "denied",
            details: { completed: 0 },
        });
    });
    it("does not disclose mail-origin tasks without mail:read", async () => {
        service.get.mockResolvedValue({
            unchanged: false,
            taskGroupOrder: ["eliška veselá"],
            points: [],
            suggestions: [],
            tasks: [
                {
                    id: "mail-task",
                    evidenceItemKind: "mail",
                    assigneeHint: "Eliška Veselá",
                },
            ],
            invitees: [],
            taskGroups: [],
        });
        const result = await run("get_meeting", { meetingId: "agenda" });
        expect(result).toMatchObject({
            meeting: { tasks: [], taskGroups: [], taskGroupOrder: [] },
        });
        expect(JSON.stringify(result)).not.toMatch(/eliška/iu);
    });
    it.each([
        "get_meeting",
        "list_meetings",
    ])("%s conceals the task review without tasks:read", async (name) => {
        service.get.mockResolvedValue({
            unchanged: false,
            taskGroupOrder: [],
            points: [],
            suggestions: [],
            tasks: [{ id: "task", text: "Private task", note: "Note" }],
            invitees: [],
            taskGroups: [{ tasks: ["task"] }],
            taskSource: { id: "source" },
            noTaskSource: true,
        });
        service.list.mockResolvedValue([
            { id: "agenda", counts: { points: 1, tasks: 2 } },
        ]);
        const result = await run(
            name,
            name === "get_meeting" ? { meetingId: "agenda" } : {},
            { ...caller, roles: new Set(["summaries:read"]) },
        );
        expect(JSON.stringify(result)).not.toContain("Private task");
        if (name === "get_meeting")
            expect(result).toMatchObject({
                meeting: {
                    tasks: [],
                    taskGroups: [],
                    taskSource: null,
                    noTaskSource: null,
                },
            });
        else
            expect(result).toMatchObject({
                meetings: [{ counts: { points: 1, tasks: undefined } }],
            });
    });
    it("returns task review when tasks:read is granted", async () => {
        service.get.mockResolvedValue({
            unchanged: false,
            taskGroupOrder: [],
            points: [],
            suggestions: [],
            tasks: [{ id: "task", evidenceItemKind: "audio" }],
            invitees: [],
            taskGroups: [],
            noTaskSource: true,
        });
        expect(await run("get_meeting", { meetingId: "agenda" })).toMatchObject(
            { meeting: { tasks: [{ id: "task" }], noTaskSource: true } },
        );
        service.list.mockResolvedValue([
            { id: "agenda", counts: { points: 1, tasks: 2 } },
        ]);
        expect(await run("list_meetings", {})).toMatchObject({
            meetings: [{ counts: { tasks: 2 } }],
        });
    });
    it.each([
        "prepare_meeting",
        "edit_agenda",
        "update_agenda",
        "suggest_agenda_points",
    ])("refuses service callers on %s", async (name) => {
        const principal: McpCaller = {
            kind: "service",
            orgUserId: "org",
            subject: "service",
            clientId: "test",
            roles: new Set(["tasks:write"]),
        };
        await expect(
            run(
                name,
                name === "prepare_meeting"
                    ? { folderId: "folder", title: "Acme" }
                    : name !== "edit_agenda"
                      ? { meetingId: "agenda", title: "Changed" }
                      : {
                            meetingId: "agenda",
                            operations: [
                                { action: "add_point", text: "Point" },
                            ],
                        },
                principal,
            ),
        ).rejects.toMatchObject({ outcome: "denied" });
        expect(service.prepare).not.toHaveBeenCalled();
        expect(service.add).not.toHaveBeenCalled();
        expect(service.patch).not.toHaveBeenCalled();
        expect(service.enqueue).not.toHaveBeenCalled();
    });
});

it.each([
    "tasks:read",
    "summaries:read",
] as const)("filters mail-derived suggestions and accepted points with role %s", async (role) => {
    service.get.mockResolvedValue({
        unchanged: false,
        taskGroupOrder: [],
        id: "agenda",
        tasks: [],
        invitees: [],
        taskGroups: [],
        suggestions: [
            { id: "mail-suggestion", text: "Mail topic" },
            { id: "audio-suggestion", text: "Audio topic" },
        ],
        points: [
            { id: "mail-point", text: "Mail topic", parentId: null },
            { id: "audio-point", text: "Audio topic", parentId: null },
        ],
        pointTree: [{ id: "mail-point", text: "Mail topic" }],
    });
    service.mail.mockResolvedValue({
        suggestionIds: new Set(["mail-suggestion"]),
        pointIds: new Set(["mail-point"]),
    });
    const result = await run(
        "get_meeting",
        { meetingId: "agenda" },
        { ...caller, roles: new Set([role]) },
    );
    expect(JSON.stringify(result)).not.toContain("Mail topic");
    expect(result).toMatchObject({
        meeting: {
            suggestions: [{ id: "audio-suggestion" }],
            points: [{ id: "audio-point" }],
        },
    });
    service.mail.mockClear();
    expect(
        await run(
            "get_meeting",
            { meetingId: "agenda" },
            { ...caller, roles: new Set([role, "mail:read"]) },
        ),
    ).toMatchObject({
        meeting: {
            suggestions: [
                { id: "mail-suggestion" },
                { id: "audio-suggestion" },
            ],
        },
    });
    expect(service.mail).not.toHaveBeenCalled();
});
it("withholds a task with merged mail-derived notes even when its current evidence is audio", async () => {
    service.get.mockResolvedValue({
        unchanged: false,
        taskGroupOrder: [],
        id: "agenda",
        points: [],
        suggestions: [],
        invitees: [],
        tasks: [
            {
                id: "task",
                evidenceItemKind: "audio",
                noteMailSourced: true,
                note: "Mail content",
            },
        ],
    });
    expect(await run("get_meeting", { meetingId: "agenda" })).toMatchObject({
        meeting: { tasks: [] },
    });
});

it.each([
    [
        { action: "reorder_tasks", groupKey: "group", taskIds: ["two", "one"] },
        "reorder",
        [
            "owner",
            "agenda",
            {
                action: "reorder_tasks",
                groupKey: "group",
                taskIds: ["two", "one"],
            },
        ],
    ],
    [
        { action: "set_task_note", taskId: "task", note: "Follow up" },
        "changeTask",
        ["owner", "agenda", "task", { note: "Follow up" }],
    ],
    [
        { action: "set_task_note", taskId: "task", note: null },
        "changeTask",
        ["owner", "agenda", "task", { note: null }],
    ],
    [
        { action: "restore_task", taskId: "task" },
        "changeTask",
        ["owner", "agenda", "task", { removed: false }],
    ],
    [
        { action: "add_suggestion", suggestionId: "suggestion" },
        "decide",
        ["owner", "agenda", "suggestion", "added"],
    ],
    [
        { action: "dismiss_suggestion", suggestionId: "suggestion" },
        "decide",
        ["owner", "agenda", "suggestion", "dismissed"],
    ],
    [
        { action: "dismiss_suggestions", kind: "ai" },
        "dismiss",
        ["owner", "agenda", "ai"],
    ],
    [
        { action: "dismiss_suggestions", kind: "carry_over" },
        "dismiss",
        ["owner", "agenda", "carry_over"],
    ],
] as const)("delegates %j to the web service", async (operation, method, args) => {
    expect(
        await run(
            "edit_agenda",
            { meetingId: "agenda", operations: [operation] },
            { ...caller, roles: new Set([...caller.roles, "mail:read"]) },
        ),
    ).toMatchObject({ completed: 1 });
    expect(service[method]).toHaveBeenCalledWith(...args);
});

it("returns every editing identifier and only visible group keys", async () => {
    service.get.mockResolvedValue({
        unchanged: false,
        id: "agenda",
        version: 7,
        taskGroupOrder: ["hidden", "jitka dvořáková"],
        points: [{ id: "point", version: 2, parentId: null }],
        suggestions: [
            { id: "ai", kind: "ai" },
            { id: "carry", kind: "carry_over" },
        ],
        tasks: [
            { id: "task", assigneeHint: "Jitka Dvořáková" },
            { id: "removed", removedAt: "2026-11-01" },
        ],
        invitees: [],
    });
    expect(await run("get_meeting", { meetingId: "agenda" })).toMatchObject({
        meeting: {
            version: 7,
            points: [{ id: "point", version: 2 }],
            suggestions: [
                { id: "ai", kind: "ai" },
                { id: "carry", kind: "carry_over" },
            ],
            tasks: [{ id: "task" }, { id: "removed" }],
            taskGroups: [{ key: "jitka dvořáková", tasks: [{ id: "task" }] }],
            taskGroupOrder: ["jitka dvořáková"],
        },
    });
});

it("passes all agenda metadata and concurrency fields to patchMeeting", async () => {
    const fields = {
        title: "Changed",
        start: "2026-11-10T10:00:00Z",
        end: "2026-11-10T11:00:00Z",
        calendarEventId: null,
        state: "live",
        taskSourceItemId: null,
        noTaskSource: true,
        taskGroupOrder: ["group"],
        version: 3,
        previous: {
            title: "Original",
            start: null,
            end: null,
            calendarEventId: "event",
            taskSourceItemId: null,
            noTaskSource: false,
            taskGroupOrder: [],
        },
    };
    await run(
        "update_agenda",
        { meetingId: "agenda", ...fields },
        { ...caller, roles: new Set([...caller.roles, "mail:read"]) },
    );
    expect(service.patch).toHaveBeenCalledWith("owner", "agenda", fields);
});

it.each([
    { taskGroupOrder: ["group"] },
    { title: "Changed", previous: {} },
    { noTaskSource: true, previous: { noTaskSource: false } },
])("retains web cross-field validation for %j", async (fields) => {
    await expect(
        run("update_agenda", { meetingId: "agenda", ...fields }),
    ).rejects.toMatchObject({ outcome: "invalid" });
    expect(service.patch).not.toHaveBeenCalled();
});

it.each([
    undefined,
    "en",
    "cs-CZ",
])("enqueues suggestions with locale %s and returns job state", async (locale) => {
    service.enqueue.mockResolvedValue({
        jobId: "job",
        available: true,
        reason: null,
    });
    service.get.mockResolvedValue({
        unchanged: false,
        id: "agenda",
        points: [],
        tasks: [],
        taskGroupOrder: [],
        invitees: [],
        suggestions: [],
        aiSuggestions: { job: { state: "queued" } },
    });
    expect(
        await run("suggest_agenda_points", { meetingId: "agenda", locale }),
    ).toMatchObject({
        jobId: "job",
        meeting: { aiSuggestions: { job: { state: "queued" } } },
    });
    expect(service.enqueue).toHaveBeenCalledWith("owner", "agenda", locale);
});

it.each([
    [400, "invalid"],
    [403, "denied"],
    [404, "not_found"],
    [409, "conflict"],
] as const)("maps web errors (%s) consistently for new tools and operations", async (status, outcome) => {
    const error = new AppError(ErrorCode.CONFLICT, "Refused", status, {
        version: 4,
    });
    service.patch.mockRejectedValueOnce(error);
    await expect(
        run("update_agenda", { meetingId: "agenda", title: "New", version: 1 }),
    ).rejects.toMatchObject({ outcome, details: { version: 4 } });
    service.enqueue.mockRejectedValueOnce(error);
    await expect(
        run("suggest_agenda_points", { meetingId: "agenda" }),
    ).rejects.toMatchObject({ outcome });
    service.reorder.mockRejectedValueOnce(error);
    await expect(
        run(
            "edit_agenda",
            {
                meetingId: "agenda",
                operations: [
                    { action: "add_task", taskId: "task" },
                    {
                        action: "reorder_tasks",
                        groupKey: "group",
                        taskIds: ["task"],
                    },
                    { action: "restore_task", taskId: "task" },
                ],
            },
            { ...caller, roles: new Set([...caller.roles, "mail:read"]) },
        ),
    ).rejects.toMatchObject({ outcome, details: { completed: 1, version: 4 } });
    expect(service.changeTask).not.toHaveBeenCalled();
});

function checkDescriptions(schema: unknown, path: string, field = false) {
    if (!(schema instanceof z.ZodType))
        throw new Error(`Invalid Zod schema at ${path}`);
    if (field) expect(schema.description, path).toBeTruthy();
    if (schema instanceof z.ZodObject) {
        for (const [key, child] of Object.entries(schema.shape))
            checkDescriptions(child, `${path}.${key}`, true);
    } else if (
        schema instanceof z.ZodOptional ||
        schema instanceof z.ZodNullable
    ) {
        checkDescriptions(schema.unwrap(), path);
    } else if (schema instanceof z.ZodArray) {
        checkDescriptions(schema.element, `${path}[]`);
    } else if (schema instanceof z.ZodUnion) {
        for (const option of schema.options) checkDescriptions(option, path);
    }
}

it("describes every tool and input field, including nested previous fields and every operation", () => {
    for (const tool of MEETING_TOOLS) {
        expect(tool.description, tool.name).toBeTruthy();
        checkDescriptions(z.object(tool.input(caller)), tool.name);
        const json = z.toJSONSchema(z.object(tool.input(caller)), {
            target: "draft-7",
            io: "input",
        });
        expect(json.type).toBe("object");
    }
    for (const name of ["edit_agenda", "update_agenda"])
        expect(
            MEETING_TOOLS.find((tool) => tool.name === name)?.annotations
                .destructiveHint,
        ).toBe(true);
    expect(
        MEETING_TOOLS.find((tool) => tool.name === "suggest_agenda_points")
            ?.annotations,
    ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
    });
});

it("passes merge-up removal to the same deletion service as the web editor", async () => {
    await run("edit_agenda", {
        meetingId: "agenda",
        operations: [
            {
                action: "remove_point",
                pointId: "point",
                version: 2,
                mergeUp: true,
            },
        ],
    });
    expect(service.change).toHaveBeenCalledWith(
        "owner",
        "agenda",
        "point",
        { version: 2, mergeUp: true },
        true,
    );
});
