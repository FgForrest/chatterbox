import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    gate: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    point: vi.fn(),
    match: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: mocks.gate,
}));
vi.mock("@/lib/meetings/service", () => ({
    listMeetings: mocks.list,
    reminderMeetings: mocks.list,
    getMeeting: mocks.get,
    addPoint: mocks.point,
    changePoint: mocks.point,
    meetingFolderPaths: async () => () => "Private / Acme",
}));
vi.mock("@/lib/meetings/calendar", () => ({
    matchRecorderAgendas: mocks.match,
}));
vi.mock("@/lib/recorder/config", () => ({
    getRecorderServerConfig: () => ({}),
    serializeRecorderServerConfig: () => ({ noticeText: "Recording notice" }),
}));

import { PATCH as patchPoint } from "@/app/api/v1/recorder/agendas/[id]/points/[pointId]/route";
import { POST as add } from "@/app/api/v1/recorder/agendas/[id]/points/route";
import { GET as detail } from "@/app/api/v1/recorder/agendas/[id]/route";
import { GET as match } from "@/app/api/v1/recorder/agendas/match/route";
import { GET as agendas } from "@/app/api/v1/recorder/agendas/route";
import { GET as config } from "@/app/api/v1/recorder/config/route";
import { parseCompleteRecordingSessionBody } from "@/lib/recording-sessions/metadata";

const context = { params: Promise.resolve({ id: "agenda" }) };
beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockResolvedValue({
        authn: { user: { id: "owner" }, apiKeyId: "key" },
    });
    mocks.list.mockResolvedValue([
        { id: "agenda", timeSet: true, folders: [] },
    ]);
    mocks.get.mockResolvedValue({ id: "agenda", points: [] });
    mocks.point.mockResolvedValue({ id: "point" });
    mocks.match.mockResolvedValue([]);
});

describe("recorder agenda API", () => {
    it("adds the capability without changing existing config fields", async () => {
        expect(
            await (
                await config(
                    new Request("https://example.com/api/v1/recorder/config"),
                )
            ).json(),
        ).toEqual({
            noticeText: "Recording notice",
            features: { agendas: true },
        });
    });
    it.each([
        agendas,
        detail,
        match,
    ])("returns the recorder auth refusal before touching agendas", async (handler) => {
        mocks.gate.mockResolvedValue({
            response: Response.json({ error: "Unauthorized" }, { status: 401 }),
        });
        expect(
            (
                await handler(
                    new Request("https://example.com/api/v1/recorder/agendas"),
                    context,
                )
            ).status,
        ).toBe(401);
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.get).not.toHaveBeenCalled();
        expect(mocks.match).not.toHaveBeenCalled();
    });
    it("uses only the recorder principal and bounds reminder windows", async () => {
        const response = await agendas(
            new Request(
                "https://example.com/api/v1/recorder/agendas?from=2026-11-03T10:00:00Z&to=2026-11-04T10:00:00Z",
            ),
            context,
        );
        expect(response.status).toBe(200);
        expect(mocks.list).toHaveBeenCalledWith(
            "owner",
            expect.objectContaining({ includePast: true }),
        );
        expect((await response.json()).data[0].folderPath).toBe(
            "Private / Acme",
        );
        expect(
            (
                await agendas(
                    new Request(
                        "https://example.com/api/v1/recorder/agendas?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z",
                    ),
                    context,
                )
            ).status,
        ).toBe(400);
    });
    it("marks quick points as live and leaves authorization to the shared service", async () => {
        const response = await add(
            new Request(
                "https://example.com/api/v1/recorder/agendas/agenda/points",
                {
                    method: "POST",
                    body: JSON.stringify({ text: "Discussion" }),
                },
            ),
            context,
        );
        expect(response.status).toBe(200);
        expect(mocks.point).toHaveBeenCalledWith("owner", "agenda", {
            text: "Discussion",
            origin: "live",
        });
    });
    it("keeps agendaId optional and refuses malformed values on complete", () => {
        const base = { chunkCount: 1, endedAt: "2026-11-03T11:00:00Z" };
        expect(
            parseCompleteRecordingSessionBody(base).agendaId,
        ).toBeUndefined();
        expect(
            parseCompleteRecordingSessionBody({ ...base, agendaId: "agenda" })
                .agendaId,
        ).toBe("agenda");
        expect(
            parseCompleteRecordingSessionBody({ ...base, agendaId: null }),
        ).toHaveProperty("agendaId", null);
        for (const agendaId of ["", 4, "x".repeat(256)])
            expect(() =>
                parseCompleteRecordingSessionBody({ ...base, agendaId }),
            ).toThrow();
    });
});

it.each([
    "text",
    "parentId",
    "position",
    "mergeUp",
])("recorder PATCH refuses structural field %s", async (field) => {
    const response = await patchPoint(
        new Request(
            "https://example.com/api/v1/recorder/agendas/agenda/points/point",
            {
                method: "PATCH",
                body: JSON.stringify({
                    version: 0,
                    [field]:
                        field === "position"
                            ? 1
                            : field === "mergeUp"
                              ? true
                              : "value",
                }),
            },
        ),
        { params: Promise.resolve({ id: "agenda", pointId: "point" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.point).not.toHaveBeenCalled();
});
it("passes the recorder polling cursor to the shared detail service", async () => {
    await detail(
        new Request(
            "https://example.com/api/v1/recorder/agendas/agenda?since=4:hidden:idle",
        ),
        context,
    );
    expect(mocks.get).toHaveBeenCalledWith("owner", "agenda", "4:hidden:idle");
});

it.each([
    true,
    false,
])("withholds summary-derived fields regardless of recording visibility %s", async (visible) => {
    mocks.get.mockResolvedValue({
        unchanged: false,
        id: "agenda",
        title: "Acme meeting",
        version: 3,
        cursor: "3:visible:idle",
        permissions: { edit: false },
        recordingItemId: "recording",
        attachedRecording: { visible },
        points: [{ id: "point", text: "Plan", summaryOutcome: "covered" }],
        pointTree: [{ id: "point", summaryOutcome: "covered", children: [] }],
        outcomeUnplanned: ["Transcript topic"],
        outcomeSummaryId: "summary",
        taskSourceItemId: "source",
        snapshotSourceItemId: "source",
        taskSource: { id: "source", title: "Previous summary title" },
        redirectTo: "/dashboard?recording=recording",
        taskGroups: [{ name: "Acme", tasks: [{ id: "task" }] }],
    });
    const response = await detail(
        new Request("https://example.com/api/v1/recorder/agendas/agenda"),
        context,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
        unchanged: false,
        id: "agenda",
        title: "Acme meeting",
        version: 3,
        cursor: "3:visible:idle",
        permissions: { edit: false },
        recordingItemId: "recording",
        attachedRecording: { visible },
        points: [{ id: "point", text: "Plan" }],
        taskGroups: [{ name: "Acme", tasks: [{ id: "task" }] }],
    });
});
it("preserves unchanged recorder polls", async () => {
    mocks.get.mockResolvedValue({
        unchanged: true,
        version: 3,
        cursor: "3:visible:idle",
    });
    const response = await detail(
        new Request("https://example.com/api/v1/recorder/agendas/agenda"),
        context,
    );
    expect(await response.json()).toEqual({
        unchanged: true,
        version: 3,
        cursor: "3:visible:idle",
    });
});

it.each([
    "add",
    "patch",
])("strips summaryOutcome from the recorder point %s response", async (operation) => {
    mocks.point.mockResolvedValue({
        id: "point",
        text: "Plan",
        version: 1,
        summaryOutcome: "covered",
    });
    const response =
        operation === "add"
            ? await add(
                  new Request(
                      "https://example.com/api/v1/recorder/agendas/agenda/points",
                      {
                          method: "POST",
                          body: JSON.stringify({ text: "Plan" }),
                      },
                  ),
                  context,
              )
            : await patchPoint(
                  new Request(
                      "https://example.com/api/v1/recorder/agendas/agenda/points/point",
                      {
                          method: "PATCH",
                          body: JSON.stringify({ version: 0, discussed: true }),
                      },
                  ),
                  {
                      params: Promise.resolve({
                          id: "agenda",
                          pointId: "point",
                      }),
                  },
              );
    expect(await response.json()).toEqual({
        id: "point",
        text: "Plan",
        version: 1,
    });
});
