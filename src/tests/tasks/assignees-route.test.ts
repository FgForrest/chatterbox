import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getAssignees } from "@/app/api/tasks/assignees/route";
import { GET as getTasks } from "@/app/api/tasks/route";
import { AppError, ErrorCode } from "@/lib/errors";
import type { TaskViewer } from "@/lib/tasks/access";

const { requireTaskViewer, listTasks, listTrackedAssignees } = vi.hoisted(
    () => ({
        requireTaskViewer: vi.fn(),
        listTasks: vi.fn(),
        listTrackedAssignees: vi.fn(),
    }),
);

vi.mock("@/lib/tasks/route-helpers", () => ({ requireTaskViewer }));
vi.mock("@/lib/tasks/tasks", () => ({ listTasks, listTrackedAssignees }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const viewer: TaskViewer = {
    userId: "user-1",
    emailHash: "viewer-hash",
    isOrg: false,
    isCurator: false,
    orgUserId: null,
};

beforeEach(() => {
    vi.clearAllMocks();
    requireTaskViewer.mockResolvedValue(viewer);
    listTasks.mockResolvedValue([]);
    listTrackedAssignees.mockResolvedValue([]);
});

describe("task assignee routes", () => {
    it.each([
        "person-1",
        "none",
        "",
    ])("passes assignee=%s alongside the other list filters", async (assignee) => {
        const request = new Request(
            `http://localhost/api/tasks?tab=tracked&state=done&folder=folder-1&assignee=${assignee}&due=week&today=2026-10-20&sort=due`,
        );
        const response = await getTasks(request);
        expect(response.status).toBe(200);
        expect(requireTaskViewer).toHaveBeenCalledWith(request);
        expect(listTasks).toHaveBeenCalledWith(viewer, {
            tab: "followed",
            organization: false,
            state: "done",
            folderId: "folder-1",
            assignee: assignee || null,
            due: "week",
            today: "2026-10-20",
            sort: "due",
        });
    });

    it("serves the authenticated viewer's assignees", async () => {
        const assignees = [{ personId: "person-1", name: "Tova Quill" }];
        listTrackedAssignees.mockResolvedValue(assignees);
        const request = new Request("http://localhost/api/tasks/assignees");
        const response = await getAssignees(request);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ assignees });
        expect(requireTaskViewer).toHaveBeenCalledWith(request);
        expect(listTrackedAssignees).toHaveBeenCalledWith(viewer, false);
    });

    it.each([
        getTasks,
        getAssignees,
    ])("requires authentication before reading tasks or people", async (handler) => {
        requireTaskViewer.mockRejectedValue(
            new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401),
        );
        const response = await handler(
            new Request("http://localhost/api/tasks"),
        );
        expect(response.status).toBe(401);
        expect(listTasks).not.toHaveBeenCalled();
        expect(listTrackedAssignees).not.toHaveBeenCalled();
    });
});
