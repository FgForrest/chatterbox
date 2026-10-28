import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as accept } from "@/app/api/recordings/[id]/tasks/accept/route";
import { POST as mergeProposals } from "@/app/api/recordings/[id]/tasks/merge/route";
import { POST as add } from "@/app/api/recordings/[id]/tasks/route";
import { POST as mergeTasks } from "@/app/api/tasks/[taskId]/merge/route";
import { PATCH as update } from "@/app/api/tasks/[taskId]/route";
import { AppError, ErrorCode } from "@/lib/errors";
import { EVENT_ORIGIN_HEADER } from "@/lib/events/origin";

const mocks = vi.hoisted(() => ({
    viewer: vi.fn(async () => ({ userId: "caller" })),
    updateTask: vi.fn(async (..._args: unknown[]) => ({})),
    addTask: vi.fn(async (..._args: unknown[]) => ({})),
    mergeTaskIntoTask: vi.fn(async (..._args: unknown[]) => ({})),
    mergeProposals: vi.fn(async (..._args: unknown[]) => ({})),
    acceptReview: vi.fn(async (..._args: unknown[]) => ({})),
}));
vi.mock("@/lib/tasks/tasks", () => mocks);
vi.mock("@/lib/tasks/proposals", () => ({}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/tasks/route-helpers", () => ({
    requireTaskViewer: mocks.viewer,
    enforceTaskWriteRateLimit: vi.fn(),
    readTaskBody: (request: Request) => request.json(),
    readVersion: (version: number) => version,
    optionalNullableString: (body: Record<string, unknown>, field: string) =>
        body[field],
    invalid: (message: string) => new Error(message),
}));

afterEach(() => vi.clearAllMocks());

const cases = [
    {
        name: "update",
        route: update,
        method: "PATCH",
        body: { version: 1, status: "done" },
        mock: mocks.updateTask,
    },
    {
        name: "add",
        route: add,
        method: "POST",
        body: { text: "New task", status: "open" },
        mock: mocks.addTask,
    },
    {
        name: "merge tasks",
        route: mergeTasks,
        method: "POST",
        body: { targetTaskId: "other", sourceVersion: 1, targetVersion: 1 },
        mock: mocks.mergeTaskIntoTask,
    },
    {
        name: "merge proposals",
        route: mergeProposals,
        method: "POST",
        body: { taskIds: ["one", "two"] },
        mock: mocks.mergeProposals,
    },
    {
        name: "match proposal",
        route: mergeProposals,
        method: "POST",
        body: { sourceTaskId: "one", targetTaskId: "two" },
        mock: mocks.mergeTaskIntoTask,
    },
    {
        name: "accept review",
        route: accept,
        method: "POST",
        body: { proposals: [], updates: [], matches: [] },
        mock: mocks.acceptReview,
    },
];

describe("task route event labels", () => {
    it.each(cases)("passes an optional origin after authorizing $name", async ({
        route,
        method,
        body,
        mock,
    }) => {
        for (const origin of ["tab-a", undefined]) {
            const response = await route(
                new Request("http://app/api/tasks/task", {
                    method,
                    headers: {
                        "content-type": "application/json",
                        ...(origin ? { [EVENT_ORIGIN_HEADER]: origin } : {}),
                    },
                    body: JSON.stringify(body),
                }),
                { params: Promise.resolve({ taskId: "task", id: "item" }) },
            );
            expect(response.status).toBeLessThan(300);
            expect(mock.mock.calls.at(-1)?.at(-1)).toBe(origin);
            expect(mock.mock.calls.at(-1)?.[0]).toEqual({ userId: "caller" });
        }
    });
    it("never uses an origin header instead of authorization", async () => {
        mocks.viewer.mockRejectedValueOnce(
            new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401),
        );
        const response = await update(
            new Request("http://app/api/tasks/task", {
                method: "PATCH",
                headers: { [EVENT_ORIGIN_HEADER]: "tab-a" },
                body: JSON.stringify({ version: 1, status: "done" }),
            }),
            { params: Promise.resolve({ taskId: "task" }) },
        );
        expect(response.status).toBe(401);
        expect(mocks.updateTask).not.toHaveBeenCalled();
    });
});
