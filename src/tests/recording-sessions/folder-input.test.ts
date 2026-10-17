import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ErrorCode } from "@/lib/errors";

const { assertFolder, createSession, gate } = vi.hoisted(() => ({
    assertFolder: vi.fn(),
    createSession: vi.fn(),
    gate: vi.fn(),
}));

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: gate,
}));
vi.mock("@/lib/folders/folders", () => ({
    assertCategorizableFolderInput: assertFolder,
}));
vi.mock("@/lib/recording-sessions/store", () => ({
    createRecordingSession: createSession,
    listRecordingSessionsForUser: vi.fn(async () => []),
}));
vi.mock("@/lib/recording-sessions/serialize", () => ({
    serializeRecordingSession: (session: unknown) => session,
}));
vi.mock("@/lib/pipeline/state", () => ({
    readPrivateProcessingForItems: vi.fn(async () => new Map()),
}));

import { POST } from "@/app/api/v1/recording-sessions/route";

const validBody = {
    clientRecordingId: "5c21c9a8-b924-44cc-bbc8-6c2c1f486522",
    mimeType: "audio/webm",
    channelLayout: ["mixed"],
    startedAt: "2026-10-15T10:00:00.000Z",
};

function request(folderId?: string) {
    return new Request("https://app.test/api/v1/recording-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            ...validBody,
            ...(folderId ? { folderId } : {}),
        }),
    });
}

describe("recording-session folder input", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        gate.mockResolvedValue({
            authn: { user: { id: "owner" }, apiKeyId: "key", via: "api-key" },
        });
        assertFolder.mockResolvedValue({
            folderId: "personal",
            ownerId: "owner",
            scope: "personal",
        });
        createSession.mockResolvedValue({
            session: { id: "session", status: "open", recordingId: null },
            key: "capture-key",
            expiresAt: new Date("2026-11-15T10:00:00.000Z"),
        });
    });

    it("validates and stores a personal folder", async () => {
        expect((await POST(request("personal"))).status).toBe(201);
        expect(assertFolder).toHaveBeenCalledWith("owner", "personal");
        expect(createSession).toHaveBeenCalledWith(
            expect.objectContaining({ folderId: "personal" }),
        );
    });

    it("validates and stores an Organization folder", async () => {
        assertFolder.mockResolvedValueOnce({
            folderId: "org",
            ownerId: "organization",
            scope: "org",
        });
        expect((await POST(request("org"))).status).toBe(201);
        expect(createSession).toHaveBeenCalledWith(
            expect.objectContaining({ folderId: "org" }),
        );
    });

    it("leaves folderId null when omitted", async () => {
        expect((await POST(request())).status).toBe(201);
        expect(assertFolder).not.toHaveBeenCalled();
        expect(createSession).toHaveBeenCalledWith(
            expect.objectContaining({ folderId: null }),
        );
    });

    it.each([
        ["root", ErrorCode.INVALID_INPUT, 400],
        ["unknown", ErrorCode.INVALID_INPUT, 400],
        ["foreign", ErrorCode.INVALID_INPUT, 400],
    ])("returns 400 for unusable folder %s", async (folderId, code, status) => {
        assertFolder.mockRejectedValueOnce(
            new AppError(code, "Folder not found", status),
        );
        const response = await POST(request(folderId));
        expect(response.status).toBe(400);
        expect(createSession).not.toHaveBeenCalled();
    });
});
