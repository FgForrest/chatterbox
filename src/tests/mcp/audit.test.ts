import { afterEach, describe, expect, it, vi } from "vitest";

const { prune } = vi.hoisted(() => ({ prune: vi.fn() }));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: { MCP_AUDIT_RETENTION_DAYS: 30 } }));
vi.mock("@/db/queries/mcp-audit", () => ({ pruneMcpAccessLog: prune }));

import { startMcpAuditPruner } from "@/lib/mcp/audit";

describe("startMcpAuditPruner", () => {
    afterEach(() => {
        vi.useRealTimers();
        prune.mockReset();
    });

    it("prunes hourly with the configured retention until a batch runs short", async () => {
        vi.useFakeTimers();
        prune
            .mockResolvedValueOnce(5_000)
            .mockResolvedValueOnce(5_000)
            .mockResolvedValueOnce(12);
        startMcpAuditPruner();
        startMcpAuditPruner();
        expect(prune).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(prune).toHaveBeenCalledTimes(3);
        expect(prune).toHaveBeenCalledWith(30, 5_000);

        prune.mockReset();
        prune.mockRejectedValueOnce(new Error("db down"));
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(prune).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(
            "[mcp] audit prune failed",
            "db down",
        );
        error.mockRestore();
    });
});
