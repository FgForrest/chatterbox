import { beforeEach, expect, it, vi } from "vitest";
import { GET as recorderConfig } from "@/app/api/v1/recorder/config/route";
import { POST as createRecordingSession } from "@/app/api/v1/recording-sessions/route";
import { authenticateRequest } from "@/lib/auth-request";
import { AppError, ErrorCode, errorResponse } from "@/lib/errors";
import { consumeRateLimitBucket } from "@/lib/rate-limit";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth-request", () => ({
    authenticateRequest: vi.fn(),
    requireApiScope: vi.fn(),
}));
vi.mock("@/lib/entitlements", () => ({ isHostedLockedOut: vi.fn() }));
vi.mock("@/lib/org/config", () => ({ assertNotOrgAccount: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: vi.fn(),
    getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/folders/folders", () => ({
    assertCategorizableFolderInput: vi.fn(),
}));
vi.mock("@/lib/pipeline/state", () => ({
    readPrivateProcessingForItems: vi.fn(),
}));
vi.mock("@/lib/recording-sessions/store", () => ({
    createRecordingSession: vi.fn(),
    listRecordingSessionsForUser: vi.fn(),
}));

const routes = [
    ["/api/v1/recorder/config", "GET", recorderConfig],
    ["/api/v1/recording-sessions", "POST", createRecordingSession],
] as const;
const resetAt = new Date(Date.now() + 60_000);

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    vi.mocked(consumeRateLimitBucket).mockResolvedValue({
        allowed: true,
        limit: 10,
        remaining: 9,
        resetAt,
    });
});

it.each(
    routes,
)("uses the error envelope for unauthorized requests to %s", async (path, method, handler) => {
    const response = await handler(
        new Request(`http://localhost${path}`, { method }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
        error: "Unauthorized",
        code: "UNAUTHORIZED",
    });
});

it.each(
    routes,
)("keeps the envelope and Retry-After when %s is rate limited", async (path, method, handler) => {
    vi.mocked(consumeRateLimitBucket).mockResolvedValue({
        allowed: false,
        limit: 10,
        remaining: 0,
        resetAt,
    });
    const response = await handler(
        new Request(`http://localhost${path}`, { method }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await response.json()).toMatchObject({
        error: "Rate limit exceeded",
        code: "RATE_LIMITED",
    });
});

it("keeps the error message and code in direct error responses", async () => {
    const response = errorResponse(
        new AppError(ErrorCode.NOT_FOUND, "Recording session not found", 404),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
        error: "Recording session not found",
        code: "NOT_FOUND",
    });
});
