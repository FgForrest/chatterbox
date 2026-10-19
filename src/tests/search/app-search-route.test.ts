import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/app-search/route";
import { AppError, ErrorCode } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
    viewer: vi.fn(),
    search: vi.fn(),
    bucket: vi.fn(),
}));
vi.mock("@/lib/tasks/route-helpers", () => ({
    requireTaskViewer: mocks.viewer,
}));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimitBucket: mocks.bucket }));
vi.mock("@/lib/search/app-search", () => ({ searchApp: mocks.search }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

const viewer = {
    userId: "alice",
    orgUserId: null,
    emailHash: "hash",
    isOrg: false,
    isCurator: false,
};
const results = { chatter: [], almanac: [], tasks: [], limited: false };
beforeEach(() => {
    vi.clearAllMocks();
    mocks.viewer.mockResolvedValue(viewer);
    mocks.search.mockResolvedValue(results);
    mocks.bucket.mockResolvedValue({ allowed: true });
});

describe("GET /api/app-search", () => {
    it.each([
        "chatter",
        "almanac",
        "tasks",
        "all",
    ])("passes the authenticated viewer and %s scope", async (scope) => {
        const request = new Request(
            `http://localhost/api/app-search?scope=${scope}&q=%20hello%20`,
        );
        const response = await GET(request);
        expect(mocks.viewer).toHaveBeenCalledWith(request);
        expect(mocks.search).toHaveBeenCalledWith(
            viewer,
            scope,
            "hello",
            request.signal,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(await response.json()).toEqual(results);
    });
    it("defaults to Chatter and accepts an empty query for recent results", async () => {
        await GET(new Request("http://localhost/api/app-search"));
        expect(mocks.search).toHaveBeenCalledWith(
            viewer,
            "chatter",
            "",
            expect.any(AbortSignal),
        );
    });
    it.each([
        "scope=private",
        "q=x",
        "q=%20x%20",
        `q=${"x".repeat(201)}`,
    ])("rejects invalid input: %s", async (query) => {
        const response = await GET(
            new Request(`http://localhost/api/app-search?${query}`),
        );
        expect(response.status).toBe(400);
        expect(mocks.search).not.toHaveBeenCalled();
    });
    it("limits decrypting searches per user and returns Retry-After", async () => {
        mocks.bucket.mockResolvedValue({
            allowed: false,
            resetAt: new Date(Date.now() + 30_000),
        });
        const response = await GET(
            new Request("http://localhost/api/app-search?q=hello"),
        );
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(mocks.bucket).toHaveBeenCalledWith("app-search:alice", {
            limit: 10,
            windowMs: 60_000,
        });
        expect(mocks.search).not.toHaveBeenCalled();
    });
    it("requires a signed-in, authorized viewer", async () => {
        mocks.viewer.mockRejectedValue(
            new AppError(ErrorCode.AUTH_SESSION_MISSING, "Unauthorized", 401),
        );
        expect(
            (
                await GET(
                    new Request("http://localhost/api/app-search?scope=all"),
                )
            ).status,
        ).toBe(401);
        expect(mocks.search).not.toHaveBeenCalled();
    });
});
