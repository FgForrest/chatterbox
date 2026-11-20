import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@/lib/errors";
import { captureServerException } from "@/lib/posthog-server";
import {
    claimUsersForSync,
    startBackgroundSyncWorker,
} from "@/lib/sync/worker";

const { dbMock, envMock, syncMock } = vi.hoisted(() => ({
    dbMock: {
        select: vi.fn(),
    },
    envMock: {
        IS_HOSTED: true,
        BACKGROUND_SYNC_ENABLED: true,
        BACKGROUND_SYNC_INTERVAL_MS: 5 * 60 * 1000,
    },
    syncMock: {
        syncRecordingsForUser: vi.fn(),
    },
}));

vi.mock("@/db", () => ({ db: dbMock }));
vi.mock("@/db/schema", () => ({
    plaudConnections: {
        userId: "user_id",
        lastSync: "last_sync",
        invalidatedAt: "invalidated_at",
    },
    users: {
        id: "id",
        plan: "plan",
        suspendedAt: "suspended_at",
    },
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/sync/sync-recordings", () => syncMock);

function stubClaimQuery(rows: { userId: string }[]) {
    const where = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
        }),
    });
    dbMock.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({ where }),
        }),
    });
    return where;
}

describe("claimUsersForSync", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        envMock.IS_HOSTED = true;
    });

    it("returns user IDs from the query", async () => {
        stubClaimQuery([{ userId: "u1" }, { userId: "u2" }]);
        const result = await claimUsersForSync();
        expect(result).toEqual(["u1", "u2"]);
    });

    it("returns empty array when no eligible users need sync", async () => {
        stubClaimQuery([]);
        const result = await claimUsersForSync();
        expect(result).toEqual([]);
    });

    it("filters on hosted_pro when IS_HOSTED is true", async () => {
        envMock.IS_HOSTED = true;
        const where = stubClaimQuery([]);
        await claimUsersForSync();
        // 3 conditions: suspendedAt, lastSync staleness, plan === hosted_pro
        expect(where).toHaveBeenCalledTimes(1);
    });

    it("does not filter on plan when IS_HOSTED is false (self-host)", async () => {
        envMock.IS_HOSTED = false;
        stubClaimQuery([{ userId: "self-host-user" }]);
        const result = await claimUsersForSync();
        expect(result).toEqual(["self-host-user"]);
    });
});

describe("startBackgroundSyncWorker", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        envMock.IS_HOSTED = false;
        envMock.BACKGROUND_SYNC_ENABLED = true;
        envMock.BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000;
        stubClaimQuery([]);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("does not schedule anything when BACKGROUND_SYNC_ENABLED is false", () => {
        envMock.BACKGROUND_SYNC_ENABLED = false;
        startBackgroundSyncWorker();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("counts returned failures and reconnects without logging user content or counting skips", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const thrown = new Error(
            "Unexpected sync failure with a private title",
        );
        stubClaimQuery(
            [
                "healthy",
                "partial",
                "reconnect",
                "failed",
                "skipped",
                "threw",
            ].map((userId) => ({ userId })),
        );
        syncMock.syncRecordingsForUser
            .mockResolvedValueOnce({ errors: [] })
            .mockResolvedValueOnce({
                errors: ["Failed to sync Example Meeting"],
            })
            .mockResolvedValueOnce({ errors: [], needsReconnect: true })
            .mockResolvedValueOnce({
                errors: ["Sensitive upstream message"],
                errorCode: ErrorCode.PLAUD_API_ERROR,
            })
            .mockResolvedValueOnce({
                errors: ["No Plaud connection found"],
                skipped: "no_connection",
            })
            .mockRejectedValueOnce(thrown);

        startBackgroundSyncWorker();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(error.mock.calls).toEqual([
            [
                "[background-sync] user=partial errors=1 needsReconnect=false skipped=false",
            ],
            [
                "[background-sync] user=reconnect errors=0 needsReconnect=true skipped=false",
            ],
            [
                "[background-sync] user=failed errors=1 needsReconnect=false skipped=false code=PLAUD_API_ERROR",
            ],
            [
                "[background-sync] user=threw errors=1 needsReconnect=false skipped=false code=INTERNAL_ERROR",
            ],
        ]);
        expect(log.mock.calls).toEqual([
            ["[background-sync] synced=1 errors=4"],
        ]);
        expect(captureServerException).toHaveBeenCalledExactlyOnceWith(
            new Error("Background sync failed"),
            {
                source: "worker:sync",
                distinctId: "threw",
                code: ErrorCode.INTERNAL_ERROR,
            },
        );
        const [reported] = vi.mocked(captureServerException).mock.calls[0];
        expect(reported).not.toBe(thrown);
        if (!(reported instanceof Error))
            throw new Error("Expected a sanitized error");
        expect(reported.stack).not.toContain("private title");
        expect(reported.message).not.toContain("private title");
    });
});
