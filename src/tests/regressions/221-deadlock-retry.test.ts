import { describe, expect, it, vi } from "vitest";
import { isDeadlock, retryOnDeadlock } from "@/lib/deadlock-retry";

describe("#221 deadlock retries", () => {
    it.each([
        false,
        true,
    ])("retries one PostgreSQL deadlock and returns success (wrapped: %s)", async (wrapped) => {
        const deadlock = Object.assign(new Error("deadlock detected"), {
            code: "40P01",
        });
        const error = wrapped
            ? new Error("Failed query", { cause: deadlock })
            : deadlock;
        const run = vi
            .fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce("committed");
        await expect(retryOnDeadlock(run)).resolves.toBe("committed");
        expect(run).toHaveBeenCalledTimes(2);
    });

    it.each([
        new Error("refused"),
        Object.assign(new Error("serialization failure"), { code: "40001" }),
        null,
    ])("does not retry other errors (%s)", async (error) => {
        const run = vi.fn().mockRejectedValue(error);
        await expect(retryOnDeadlock(run)).rejects.toBe(error);
        expect(run).toHaveBeenCalledOnce();
        expect(isDeadlock(error)).toBe(false);
    });

    it("gives up after one retry and preserves the final error", async () => {
        const first = Object.assign(new Error("first deadlock"), {
            code: "40P01",
        });
        const last = Object.assign(new Error("second deadlock"), {
            code: "40P01",
        });
        const run = vi
            .fn()
            .mockRejectedValueOnce(first)
            .mockRejectedValueOnce(last);
        await expect(retryOnDeadlock(run)).rejects.toBe(last);
        expect(run).toHaveBeenCalledTimes(2);
    });
    it.each([
        false,
        true,
    ])("retries serialization failures only when enabled (wrapped: %s)", async (wrapped) => {
        const error = Object.assign(new Error("serialization failure"), {
            code: "40001",
        });
        const failure = wrapped
            ? new Error("Failed query", { cause: error })
            : error;
        const run = vi
            .fn()
            .mockRejectedValueOnce(failure)
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce("committed");
        await expect(
            retryOnDeadlock(run, { retrySerialization: true }),
        ).resolves.toBe("committed");
        expect(run).toHaveBeenCalledTimes(3);
    });
    it("bounds serialization retries and preserves the last error", async () => {
        const error = Object.assign(new Error("serialization failure"), {
            code: "40001",
        });
        const run = vi.fn().mockRejectedValue(error);
        await expect(
            retryOnDeadlock(run, { retrySerialization: true }),
        ).rejects.toBe(error);
        expect(run).toHaveBeenCalledTimes(3);
    });
    it("does not retry a refusal after retrying a serialization failure", async () => {
        const error = Object.assign(new Error("serialization failure"), {
            code: "40001",
        });
        const refusal = new Error("refused");
        const run = vi
            .fn()
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(refusal);
        await expect(
            retryOnDeadlock(run, { retrySerialization: true }),
        ).rejects.toBe(refusal);
        expect(run).toHaveBeenCalledTimes(2);
    });
});
