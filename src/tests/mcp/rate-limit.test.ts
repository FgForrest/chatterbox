import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consume, clientIp } = vi.hoisted(() => ({
    consume: vi.fn(),
    clientIp: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: consume,
    getClientIp: clientIp,
}));

import type { McpCaller } from "@/lib/mcp/caller";
import {
    allowMcpScan,
    limitMcpSubject,
    MCP_CALLER_LIMIT,
    MCP_SCAN_LIMIT,
    mcpClientIp,
} from "@/lib/mcp/rate-limit";

const caller: McpCaller = {
    kind: "user",
    userId: "user-alice",
    email: "alice@example.test",
    subject: "alice-sub",
    clientId: "claude",
    roles: new Set(["transcripts:read"]),
    orgUserId: null,
};

const request = () =>
    new Request("http://localhost/api/mcp", { method: "POST" });

function allowed() {
    return {
        allowed: true,
        limit: 1,
        remaining: 1,
        resetAt: new Date(Date.now() + 60_000),
    };
}

function refused(resetInMs: number) {
    return {
        allowed: false,
        limit: 1,
        remaining: 0,
        resetAt: new Date(Date.now() + resetInMs),
    };
}

describe("MCP rate limits", () => {
    beforeEach(() => {
        clientIp.mockReturnValue("203.0.113.7");
    });

    afterEach(() => {
        consume.mockReset();
        clientIp.mockReset();
    });

    it("reports the client IP for the audit log, none when unknown", () => {
        expect(mcpClientIp(request())).toBe("203.0.113.7");
        clientIp.mockReturnValue("unknown");
        expect(mcpClientIp(request())).toBeNull();
    });

    it("keys the caller budget by the token's subject and client", async () => {
        consume.mockResolvedValue(allowed());
        await expect(
            limitMcpSubject({ sub: "alice-sub", azp: "claude" }),
        ).resolves.toBeNull();
        const [key, config] = consume.mock.calls[0] ?? [];
        expect(key).toBe('mcp:caller:["alice-sub","claude"]');
        expect(config).toEqual({ limit: MCP_CALLER_LIMIT, windowMs: 60_000 });

        await limitMcpSubject({ sub: "alice-sub", azp: "cursor" });
        expect(consume.mock.calls[1]?.[0]).not.toBe(key);
    });

    it("takes client_id when the token has no azp, as the caller does", async () => {
        consume.mockResolvedValue(allowed());
        await limitMcpSubject({ sub: "sa-uuid", client_id: "intranet-bot" });
        await limitMcpSubject({ sub: "sa-uuid", azp: "", client_id: "bot" });
        await limitMcpSubject({ sub: "sa-uuid" });
        expect(consume.mock.calls.map((args) => args[0])).toEqual([
            'mcp:caller:["sa-uuid","intranet-bot"]',
            'mcp:caller:["sa-uuid","bot"]',
            'mcp:caller:["sa-uuid",null]',
        ]);
    });

    it("answers 429 with Retry-After for a caller over its budget", async () => {
        consume.mockResolvedValue(refused(12_400));
        const response = await limitMcpSubject({ sub: "alice-sub" });
        expect(response?.status).toBe(429);
        expect(response?.headers.get("Retry-After")).toBe("13");
        await expect(response?.json()).resolves.toEqual({
            error: "Rate limit exceeded",
            code: "RATE_LIMITED",
        });
    });

    it("never asks to retry in under a second", async () => {
        consume.mockResolvedValue(refused(-5_000));
        const response = await limitMcpSubject({ sub: "alice-sub" });
        expect(response?.status).toBe(429);
        expect(response?.headers.get("Retry-After")).toBe("1");
    });

    it("counts decrypting scans apart from calls", async () => {
        consume
            .mockResolvedValueOnce(allowed())
            .mockResolvedValueOnce(refused(30_000));
        await expect(allowMcpScan(caller)).resolves.toBe(true);
        await expect(allowMcpScan(caller)).resolves.toBe(false);
        const [key, config] = consume.mock.calls[0] ?? [];
        expect(key).toMatch(/^mcp:scan:/);
        expect(key).toContain("alice-sub");
        expect(config).toEqual({ limit: MCP_SCAN_LIMIT, windowMs: 60_000 });
    });
});
