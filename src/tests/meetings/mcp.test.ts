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
}));
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
    service.mail.mockResolvedValue({
        suggestionIds: new Set(),
        pointIds: new Set(),
    });
    service.list.mockResolvedValue([{ id: "agenda" }]);
    service.get.mockResolvedValue({
        unchanged: false,
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
            points: [],
            suggestions: [],
            tasks: [{ id: "mail-task", evidenceItemKind: "mail" }],
            invitees: [],
            taskGroups: [],
        });
        expect(await run("get_meeting", { meetingId: "agenda" })).toMatchObject(
            { meeting: { tasks: [], taskGroups: [] } },
        );
    });
    it.each([
        "get_meeting",
        "list_meetings",
    ])("%s conceals the task review without tasks:read", async (name) => {
        service.get.mockResolvedValue({
            unchanged: false,
            points: [],
            suggestions: [],
            tasks: [{ id: "task", text: "Private task", note: "Note" }],
            invitees: [],
            taskGroups: [{ tasks: ["task"] }],
            taskSource: { id: "source" },
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
                meeting: { tasks: [], taskGroups: [], taskSource: null },
            });
        else
            expect(result).toMatchObject({
                meetings: [{ counts: { points: 1, tasks: undefined } }],
            });
    });
    it("returns task review when tasks:read is granted", async () => {
        service.get.mockResolvedValue({
            unchanged: false,
            points: [],
            suggestions: [],
            tasks: [{ id: "task", evidenceItemKind: "audio" }],
            invitees: [],
            taskGroups: [],
        });
        expect(await run("get_meeting", { meetingId: "agenda" })).toMatchObject(
            { meeting: { tasks: [{ id: "task" }] } },
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
                    : {
                          meetingId: "agenda",
                          operations: [{ action: "add_point", text: "Point" }],
                      },
                principal,
            ),
        ).rejects.toMatchObject({ outcome: "denied" });
        expect(service.prepare).not.toHaveBeenCalled();
        expect(service.add).not.toHaveBeenCalled();
    });
});

it.each([
    "tasks:read",
    "summaries:read",
] as const)("filters mail-derived suggestions and accepted points with role %s", async (role) => {
    service.get.mockResolvedValue({
        unchanged: false,
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
