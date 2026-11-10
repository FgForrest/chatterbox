import { beforeEach, expect, it, vi } from "vitest";

type RouteInput = {
    userId: string;
    params: { id: string; taskId: string };
    request: Request;
};
const h = vi.hoisted(() => ({
    wrap: vi.fn((handler: (input: RouteInput) => Promise<unknown>) => handler),
    access: vi.fn(async () => ({ agenda: { id: "agenda", userId: "owner" } })),
    where: vi.fn(async () => [{ taskId: "task" }]),
    viewer: vi.fn(async () => ({ userId: "caller", isOrg: false })),
    update: vi.fn(async () => ({ id: "task" })),
}));
vi.mock("@/lib/meetings/route", () => ({ meetingRoute: h.wrap }));
vi.mock("@/lib/meetings/access", () => ({ requireMeetingAccess: h.access }));
vi.mock("@/lib/tasks/access", () => ({ taskViewerById: h.viewer }));
vi.mock("@/lib/tasks/tasks", () => ({ updateTask: h.update }));
vi.mock("@/db", () => ({
    db: { select: () => ({ from: () => ({ where: h.where }) }) },
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { PATCH } from "@/app/api/v1/recorder/agendas/[id]/tasks/[taskId]/route";

const invoke = (status: string) =>
    h.wrap.mock.calls[0][0]({
        userId: "caller",
        params: { id: "agenda", taskId: "task" },
        request: new Request(
            "https://example.com/api/v1/recorder/agendas/agenda/tasks/task",
            {
                method: "PATCH",
                body: JSON.stringify({ version: 4, status }),
            },
        ),
    });
beforeEach(() => {
    h.access.mockClear();
    h.update.mockClear();
    h.where.mockResolvedValue([{ taskId: "task" }]);
});

it.each([
    "open",
    "done",
    "dropped",
])("accepts %s through the existing scoped task route", async (status) => {
    expect(PATCH).toBe(h.wrap.mock.results[0].value);
    await invoke(status);
    expect(h.access).toHaveBeenCalledWith("caller", "agenda", "edit");
    expect(h.update).toHaveBeenCalledWith(
        { userId: "caller", isOrg: false, includeReceived: true },
        "task",
        { version: 4, status },
    );
});

it("refuses a task outside the agenda before changing its status", async () => {
    h.where.mockResolvedValueOnce([]);
    await expect(invoke("open")).rejects.toMatchObject({ statusCode: 404 });
    expect(h.update).not.toHaveBeenCalled();
});

it("preserves task permission refusals when reopening", async () => {
    h.update.mockRejectedValueOnce(
        Object.assign(new Error("forbidden"), { status: 403 }),
    );
    await expect(invoke("open")).rejects.toMatchObject({ status: 403 });
});
