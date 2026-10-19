import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/onboarding/readiness/route";
import { AppError, ErrorCode } from "@/lib/errors";

const { session, capabilities, readiness } = vi.hoisted(() => ({
    session: vi.fn(),
    capabilities: vi.fn(),
    readiness: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: session }));
vi.mock("@/lib/onboarding/readiness", () => ({
    loadOnboardingCapabilities: capabilities,
    loadOnboardingReadiness: readiness,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

describe("GET /api/onboarding/readiness", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        session.mockResolvedValue({ user: { id: "session-user" } });
        capabilities.mockResolvedValue({ audience: "single-user" });
        readiness.mockResolvedValue({ plaud: "not-connected" });
    });

    it("returns 401 when signed out without reading readiness", async () => {
        session.mockRejectedValue(
            new AppError(ErrorCode.AUTH_SESSION_MISSING, "Sign in", 401),
        );
        const response = await GET(
            new Request("https://app.test/api/onboarding/readiness"),
        );
        expect(response.status).toBe(401);
        expect(capabilities).not.toHaveBeenCalled();
        expect(readiness).not.toHaveBeenCalled();
    });

    it("marks the response private and uncacheable", async () => {
        const response = await GET(
            new Request("https://app.test/api/onboarding/readiness"),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        await expect(response.json()).resolves.toEqual({
            plaud: "not-connected",
        });
    });

    it.each([
        false,
        true,
    ])("uses only the session user despite supplied query and body (body: %s)", async (body) => {
        const request = new Request(
            "https://app.test/api/onboarding/readiness?userId=other&actorUserId=org",
            body
                ? {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                          userId: "other",
                          actorUserId: "org",
                      }),
                  }
                : undefined,
        );
        await GET(request);
        expect(session).toHaveBeenCalledWith(request);
        expect(capabilities).toHaveBeenCalledExactlyOnceWith("session-user");
        expect(readiness).toHaveBeenCalledExactlyOnceWith("session-user", {
            audience: "single-user",
        });
        expect(request.bodyUsed).toBe(false);
    });
});
