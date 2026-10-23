import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";

vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: async () => ({ user: { id: "viewer" } }),
}));
vi.mock("@/lib/org/config", () => ({ isOrgScopeVisible: () => true }));
vi.mock("@/lib/sharing/person-shares", () => ({
    requirePersonSharing: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimitBucket: vi.fn() }));

beforeEach(() => {
    vi.mocked(consumeRateLimitBucket).mockReset();
    vi.mocked(consumeRateLimitBucket).mockResolvedValue({
        allowed: true,
        limit: 240,
        remaining: 1,
        resetAt: new Date(),
    });
});

describe("sharing rate limits", () => {
    it("isolates read surfaces from writes and allows repeated dashboard refreshes", async () => {
        for (const path of [
            "/api/shares",
            "/api/shares/people?q=demo",
            "/api/items/demo/shares",
        ]) {
            await requirePersonShareSession(
                new Request(`http://localhost${path}`),
            );
            expect(consumeRateLimitBucket).toHaveBeenLastCalledWith(
                `person-shares:read:${path.split("?")[0]}:viewer`,
                { limit: 240, windowMs: 60000 },
            );
        }
        await requirePersonShareSession(
            new Request("http://localhost/api/shares/demo", {
                method: "PATCH",
            }),
        );
        expect(consumeRateLimitBucket).toHaveBeenLastCalledWith(
            "person-shares:PATCH:viewer",
            { limit: 60, windowMs: 60000 },
        );
    });

    it("returns a rate-limit error for an exhausted read bucket", async () => {
        vi.mocked(consumeRateLimitBucket).mockResolvedValue({
            allowed: false,
            limit: 240,
            remaining: 0,
            resetAt: new Date(),
        });
        await expect(
            requirePersonShareSession(
                new Request("http://localhost/api/shares"),
            ),
        ).rejects.toMatchObject({ statusCode: 429 });
    });
});
