import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ErrorCode } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
    assertFolder: vi.fn(),
    getSession: vi.fn(),
    complete: vi.fn(),
    enqueue: vi.fn(),
    setJob: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: vi.fn(async () => ({
        authn: { user: { id: "owner" }, apiKeyId: "key" },
    })),
}));
vi.mock("@/lib/folders/folders", () => ({
    assertCategorizableFolderInput: mocks.assertFolder,
}));
vi.mock("@/lib/recording-sessions/store", () => ({
    getRecordingSessionForUser: mocks.getSession,
    listRecordingSessionChunks: vi.fn(async () => [{ index: 0 }]),
    markRecordingSessionCompleting: mocks.complete,
    setRecordingSessionJob: mocks.setJob,
}));
vi.mock("@/lib/recording-sessions/finalize-job", () => ({
    enqueueRecordingSessionFinalize: mocks.enqueue,
}));
vi.mock("@/lib/recording-sessions/serialize", () => ({
    serializeRecordingSession: (session: unknown) => session,
}));
vi.mock("@/lib/pipeline/state", () => ({
    readProcessing: vi.fn(async () => null),
}));

import { POST } from "@/app/api/v1/recording-sessions/[id]/complete/route";

function complete(body: Record<string, unknown> = {}) {
    return POST(
        new Request(
            "https://app.test/api/v1/recording-sessions/session/complete",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chunkCount: 1,
                    endedAt: "2026-10-20T10:00:00Z",
                    stopReason: "user",
                    ...body,
                }),
            },
        ),
        { params: Promise.resolve({ id: "session" }) },
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
        id: "session",
        userId: "owner",
        apiKeyId: "key",
        status: "open",
        folderId: "start",
    });
    mocks.assertFolder.mockResolvedValue({
        folderId: "changed",
        ownerId: "owner",
        scope: "personal",
    });
    mocks.complete.mockImplementation(async (input) => ({
        id: "session",
        status: "completing",
        folderId: input.folderId === undefined ? "start" : input.folderId,
    }));
    mocks.enqueue.mockResolvedValue({ job: { id: "job" } });
});

describe("complete session folder override", () => {
    it.each([
        "personal",
        "organization",
    ])("validates the %s target for the session owner before enqueueing", async (folderId) => {
        const response = await complete({ folderId });
        expect(response.status).toBe(202);
        expect(mocks.getSession).toHaveBeenCalledWith("session", "owner");
        expect(mocks.assertFolder).toHaveBeenCalledWith("owner", folderId);
        expect(mocks.complete).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "session",
                userId: "owner",
                folderId,
            }),
        );
        expect((await response.json()).folderId).toBe(folderId);
        expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.enqueue.mock.invocationCallOrder[0],
        );
        expect(mocks.setJob).toHaveBeenCalledWith("session", "owner", "job");
    });

    it("keeps the start folder when absent", async () => {
        const response = await complete();
        expect(response.status).toBe(202);
        expect((await response.json()).folderId).toBe("start");
        expect(mocks.assertFolder).not.toHaveBeenCalled();
        expect(mocks.complete.mock.calls[0][0].folderId).toBeUndefined();
    });

    it("clears the folder for explicit null", async () => {
        const response = await complete({ folderId: null });
        expect(response.status).toBe(202);
        expect((await response.json()).folderId).toBeNull();
        expect(mocks.assertFolder).not.toHaveBeenCalled();
    });

    it.each([
        "deleted",
        "foreign",
        "root",
    ])("refuses an unusable folder: %s", async (folderId) => {
        mocks.assertFolder.mockRejectedValueOnce(
            new AppError(ErrorCode.INVALID_INPUT, "Folder unavailable", 400, {
                field: "folderId",
            }),
        );
        const response = await complete({ folderId });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            code: "INVALID_INPUT",
            details: { field: "folderId" },
        });
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it.each([
        "",
        "   ",
        12,
        {},
        [],
        "x".repeat(256),
    ])("refuses malformed folderId %j", async (folderId) => {
        const response = await complete({ folderId });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            details: { field: "folderId" },
        });
        expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("labels root-folder errors that the shared validator returns without details", async () => {
        mocks.assertFolder.mockRejectedValueOnce(
            new AppError(
                ErrorCode.INVALID_INPUT,
                "Choose a folder below the root",
                400,
            ),
        );
        const response = await complete({ folderId: "root" });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            details: { field: "folderId" },
        });
        expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("cannot change a foreign session", async () => {
        mocks.getSession.mockResolvedValueOnce(null);
        expect((await complete({ folderId: "changed" })).status).toBe(404);
        expect(mocks.assertFolder).not.toHaveBeenCalled();
        expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("cannot change a session from another recorder key", async () => {
        mocks.getSession.mockResolvedValueOnce({
            id: "session",
            apiKeyId: "other",
            status: "open",
        });
        expect((await complete({ folderId: "changed" })).status).toBe(403);
        expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("keeps completion idempotent when the new folder has since disappeared", async () => {
        mocks.getSession.mockResolvedValueOnce({
            id: "session",
            apiKeyId: "key",
            status: "completing",
            folderId: "changed",
        });
        const response = await complete({ folderId: "deleted" });
        expect(response.status).toBe(200);
        expect(mocks.assertFolder).not.toHaveBeenCalled();
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });
});
