import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ErrorCode } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
    loadReview: vi.fn(),
    resolveItemProfile: vi.fn(),
    isLearnAvailableFor: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSessionActor: async () => ({
        session: { user: { id: "user-1" } },
        actor: { kind: "user", actorId: "user-1" },
    }),
}));
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: async () => false,
}));
vi.mock("@/lib/knowledge/availability", () => ({
    isLearnAvailableFor: mocks.isLearnAvailableFor,
}));
vi.mock("@/lib/learn/review", () => ({
    loadReview: mocks.loadReview,
    requestedReviewSource: () => "riffado",
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));
vi.mock("@/lib/sharing/access", () => ({
    requestedRecordingView: () => "private",
    requireRecordingView: async () => ({
        view: "private",
        ownerUserId: "user-1",
        role: "owner",
    }),
}));
vi.mock("@/lib/sharing/writer", () => ({ assertMayChange: vi.fn() }));

import { GET } from "@/app/api/recordings/[id]/review/route";

describe("review route profile availability", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns the review when the item's profile cannot be resolved", async () => {
        mocks.resolveItemProfile.mockRejectedValue(
            new AppError(ErrorCode.CONFLICT, "Profile is unavailable", 409),
        );
        mocks.loadReview.mockResolvedValue({
            status: "ready",
            proposals: [{ id: "proposal-1" }],
        });

        const response = await GET(
            new Request(
                "https://app.example.test/api/recordings/recording-1/review",
            ),
            { params: Promise.resolve({ id: "recording-1" }) },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            status: "ready",
            proposals: [{ id: "proposal-1" }],
            available: false,
            availabilityReason: "profile_unavailable",
        });
        expect(mocks.isLearnAvailableFor).not.toHaveBeenCalled();
    });

    it("returns a server error when profile resolution throws an unexpected error", async () => {
        mocks.resolveItemProfile.mockRejectedValue(new Error("database down"));
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const response = await GET(
            new Request(
                "https://app.example.test/api/recordings/recording-1/review",
            ),
            { params: Promise.resolve({ id: "recording-1" }) },
        );

        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({
            code: ErrorCode.INTERNAL_ERROR,
        });
        expect(mocks.loadReview).not.toHaveBeenCalled();
        expect(mocks.isLearnAvailableFor).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});
