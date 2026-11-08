import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const mocks = vi.hoisted(() => ({
    authenticate: vi.fn(),
    ip: vi.fn(),
    token: vi.fn(),
    scope: vi.fn(),
    org: vi.fn(),
    locked: vi.fn(),
}));
vi.mock("@/lib/auth-request", () => ({
    authenticateRequest: mocks.authenticate,
    requireApiScope: mocks.scope,
}));
vi.mock("@/lib/v1/rate-limit", () => ({
    enforceV1IpRateLimit: mocks.ip,
    enforceV1AuthenticatedRateLimit: mocks.token,
}));
vi.mock("@/lib/org/config", () => ({ assertNotOrgAccount: mocks.org }));
vi.mock("@/lib/entitlements", () => ({ isHostedLockedOut: mocks.locked }));

import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
        user: { id: "viewer" },
        via: "api-key",
        apiKeyId: "key",
        scopes: ["recordings:write"],
    });
    mocks.ip.mockResolvedValue(Response.json({}, { status: 429 }));
    mocks.token.mockResolvedValue(Response.json({}, { status: 429 }));
    mocks.locked.mockResolvedValue(false);
});
const request = () =>
    new Request("https://example.com/api/v1/recorder/agendas/agenda/events");
it("does not call either limiter while reauthenticating an open stream", async () => {
    expect(
        (await gateRecordingSessionRequest(request(), { rateLimit: false }))
            .authn?.user.id,
    ).toBe("viewer");
    expect(mocks.ip).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(mocks.scope).toHaveBeenCalledWith(
        expect.any(Object),
        "recordings:write",
    );
    expect(mocks.org).toHaveBeenCalledOnce();
    expect(mocks.locked).toHaveBeenCalledOnce();
});
it.each([
    "revoked",
    "scope",
    "organization",
    "hosted",
    "session",
])("still refuses %s credentials without rate limiting", async (reason) => {
    if (reason === "revoked") mocks.authenticate.mockResolvedValue(null);
    if (reason === "scope")
        mocks.scope.mockImplementation(() => {
            throw new Error("scope withdrawn");
        });
    if (reason === "organization")
        mocks.org.mockRejectedValue(new Error("organization refused"));
    if (reason === "hosted") mocks.locked.mockResolvedValue(true);
    if (reason === "session")
        mocks.authenticate.mockResolvedValue({
            user: { id: "viewer" },
            via: "session",
        });
    await expect(
        gateRecordingSessionRequest(request(), { rateLimit: false }),
    ).rejects.toThrow();
    expect(mocks.ip).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
});
