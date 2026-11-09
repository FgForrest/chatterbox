import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpCaller } from "@/lib/mcp/caller";

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));

const service = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/meetings/service", () => ({
    listMeetings: service.list,
    getMeeting: service.get,
}));
vi.mock("@/db/queries/agenda-mail-sources", () => ({
    agendaMailDerivedContent: async () => ({
        pointIds: new Set(),
        suggestionIds: new Set(),
    }),
}));
vi.mock("@/lib/mcp/scope", () => ({ mayReadMail: () => false }));

import { MEETING_TOOLS } from "@/lib/mcp/tools/meetings";

const caller: McpCaller = {
    kind: "service",
    orgUserId: "org",
    subject: "bot",
    clientId: "bot",
    roles: new Set(["tasks:read"]),
};
const sharedFolder = {
    id: "shared-folder",
    userId: "org",
    name: "Organization",
};
const privateFolder = {
    id: "private-folder",
    userId: "owner",
    name: "Private project",
};

async function call(name: string, input: Record<string, unknown> = {}) {
    const tool = MEETING_TOOLS.find((entry) => entry.name === name);
    if (!tool) throw new Error("Missing meeting tool");
    return tool.run({ caller, touched: [] }, input);
}

beforeEach(() => {
    vi.clearAllMocks();
    service.list.mockResolvedValue([{ id: "agenda", folders: [sharedFolder] }]);
    service.get.mockResolvedValue({
        id: "agenda",
        folders: [sharedFolder],
        tasks: [],
        taskGroupOrder: [],
        points: [],
        suggestions: [],
        invitees: [],
    });
});

describe("#324 service clients reading shared agendas", () => {
    it("uses the Organization viewer for list_meetings", async () => {
        expect(await call("list_meetings")).toEqual({
            meetings: [{ id: "agenda", folders: [sharedFolder] }],
        });
        expect(service.list).toHaveBeenCalledWith("org", {});
    });

    it("uses the Organization viewer for get_meeting", async () => {
        const result = await call("get_meeting", { meetingId: "agenda" });
        expect(result).toMatchObject({ meeting: { folders: [sharedFolder] } });
        expect(service.get).toHaveBeenCalledWith("org", "agenda");
    });

    it("passes folder filters to the shared service without widening its result", async () => {
        service.list.mockResolvedValueOnce([]);
        expect(
            await call("list_meetings", { folderId: privateFolder.id }),
        ).toEqual({ meetings: [] });
        expect(service.list).toHaveBeenLastCalledWith("org", {
            folderId: privateFolder.id,
        });
        expect(
            await call("list_meetings", { folderId: sharedFolder.id }),
        ).toEqual({ meetings: [{ id: "agenda", folders: [sharedFolder] }] });
    });
});
