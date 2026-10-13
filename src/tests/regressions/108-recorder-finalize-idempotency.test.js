import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingCaptureKeys, recordingSessions } from "../../db/schema";

const mockDb = vi.hoisted(() => ({ transaction: vi.fn(), update: vi.fn() }));
vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/encryption", () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));

import {
    markRecordingSessionCompleted,
    markRecordingSessionFailed,
} from "../../lib/recording-sessions/store";

beforeEach(() => {
    mockDb.transaction.mockReset();
    mockDb.update.mockReset();
});

describe("recorder finalization", () => {
    it("commits completion once and rejects a late failure", async () => {
        const dialect = new PgDialect();
        let status = "completing";
        let sessionWrites = 0;
        const update = (table) => ({
            set: (patch) => ({
                where: (condition) => {
                    const query = dialect.sqlToQuery(condition);
                    const scoped =
                        query.params.includes("session-1") &&
                        query.params.includes("user-1");
                    const statusChecked =
                        query.sql.includes('"recording_sessions"."status"') &&
                        query.params.includes("completing");
                    const permitted =
                        scoped && (!statusChecked || status === "completing");

                    if (
                        table === recordingSessions &&
                        patch.status === "completed"
                    ) {
                        return {
                            returning: async () => {
                                if (!permitted) return [];
                                status = "completed";
                                sessionWrites++;
                                return [{ captureKeyId: "capture-1" }];
                            },
                        };
                    }
                    if (
                        table === recordingSessions &&
                        patch.status === "failed"
                    ) {
                        if (permitted) {
                            status = "failed";
                            sessionWrites++;
                        }
                        return Promise.resolve([]);
                    }
                    if (table === recordingCaptureKeys)
                        return Promise.resolve([]);
                    throw new Error("Unexpected update");
                },
            }),
        });
        mockDb.transaction.mockImplementation(async (callback) =>
            callback({ update }),
        );
        mockDb.update.mockImplementation(update);

        expect(
            await markRecordingSessionCompleted(
                "session-1",
                "user-1",
                "recording-1",
            ),
        ).toBe(true);
        expect(
            await markRecordingSessionCompleted(
                "session-1",
                "user-1",
                "recording-2",
            ),
        ).toBe(false);
        await markRecordingSessionFailed("session-1", "user-1", "late timeout");
        expect(status).toBe("completed");
        expect(sessionWrites).toBe(1);
    });
});
