import { beforeEach, describe, expect, it, vi } from "vitest";

const { access, meeting } = vi.hoisted(() => ({
    access: vi.fn(),
    meeting: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "owner" } }),
}));
vi.mock("@/lib/meetings/service", () => ({ getMeeting: meeting }));
vi.mock("@/lib/sharing/access", () => ({ requireRecordingAccess: access }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { GET } from "@/app/api/recordings/[id]/agenda/route";
import { AppError, ErrorCode } from "@/lib/errors";

beforeEach(() => {
    access.mockReset().mockResolvedValue({});
    meeting.mockReset();
});

function read() {
    return GET(
        new Request("http://example.com/api/recordings/recording/agenda"),
        {
            params: Promise.resolve({ id: "recording" }),
        },
    );
}

describe("optional recording agenda", () => {
    it("returns an empty successful result for an accessible recording without an agenda", async () => {
        meeting.mockRejectedValue(
            new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404),
        );
        const response = await read();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ agenda: null });
        expect(access).toHaveBeenCalledWith("owner", "recording");
        expect(meeting).toHaveBeenCalledWith("owner", "recording");
    });
    it("returns the attached agenda using the caller's visibility", async () => {
        const agenda = {
            id: "agenda",
            recordingItemId: "recording",
            permissions: { edit: false },
        };
        meeting.mockResolvedValue(agenda);
        const response = await read();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ agenda });
    });
    it("refuses inaccessible recordings before looking up their agendas", async () => {
        access.mockRejectedValue(
            new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            ),
        );
        const response = await read();
        expect(response.status).toBe(404);
        expect(meeting).not.toHaveBeenCalled();
    });
    it("preserves failures other than a missing agenda", async () => {
        meeting.mockRejectedValue(
            new AppError(ErrorCode.FORBIDDEN, "Access denied", 403),
        );
        const response = await read();
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    });
});
