import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        BETTER_AUTH_SECRET: "better-auth-secret-with-32-chars-min",
        API_TOKEN_HASH_SECRET: undefined,
    },
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/v1/rate-limit", () => ({
    enforceV1IpRateLimit: vi.fn().mockResolvedValue(null),
    enforceV1AuthenticatedRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth-request", async () => {
    const actual =
        await vi.importActual<typeof import("@/lib/auth-request")>(
            "@/lib/auth-request",
        );
    return { ...actual, authenticateRequest: vi.fn() };
});

import { GET as listRecordings } from "@/app/api/v1/recordings/route";
import { authenticateRequest } from "@/lib/auth-request";
import { ErrorCode } from "@/lib/errors";

const req = () => new Request("http://localhost/api/v1/recordings");

describe("v1 read routes enforce the read scope", () => {
    beforeEach(() => vi.clearAllMocks());

    it("rejects a write-only recorder key with 403", async () => {
        (authenticateRequest as unknown as Mock).mockResolvedValue({
            user: { id: "u1" },
            via: "api-key",
            apiKeyId: "k1",
            scopes: ["recordings:write"],
        });

        const response = await listRecordings(req());
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.FORBIDDEN,
        });
    });

    it("rejects an unauthenticated request with 401", async () => {
        (authenticateRequest as unknown as Mock).mockResolvedValue(null);
        const response = await listRecordings(req());
        expect(response.status).toBe(401);
    });
});
