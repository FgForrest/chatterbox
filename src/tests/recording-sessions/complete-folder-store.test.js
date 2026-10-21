import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingSessions } from "../../db/schema";

const db = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/db", () => ({ db }));
vi.mock("@/lib/encryption", () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { markRecordingSessionCompleting } from "../../lib/recording-sessions/store";

beforeEach(() => vi.clearAllMocks());

describe("atomic completion folder persistence", () => {
    it.each([
        undefined,
        null,
        "changed",
    ])("persists override %j in the scoped status transition", async (folderId) => {
        let folder = "start";
        let status = "open";
        const dialect = new PgDialect();
        const update = vi.fn((table) => ({
            set: (patch) => ({
                where: (condition) => ({
                    returning: async () => {
                        expect(table).toBe(recordingSessions);
                        const query = dialect.sqlToQuery(condition);
                        expect(query.params).toEqual(
                            expect.arrayContaining([
                                "session",
                                "owner",
                                "open",
                            ]),
                        );
                        status = patch.status;
                        if ("folderId" in patch) folder = patch.folderId;
                        return [{ id: "session", status, folderId: folder }];
                    },
                }),
            }),
        }));
        const transaction = {
            select: () => ({
                from: (table) => ({
                    where: (condition) => {
                        if (table === recordingSessions) {
                            const query = dialect.sqlToQuery(condition);
                            expect(query.params).toEqual(
                                expect.arrayContaining(["session", "owner"]),
                            );
                            return {
                                for: (lock) => {
                                    expect(lock).toBe("update");
                                    return { limit: async () => [{ status }] };
                                },
                            };
                        }
                        return { orderBy: async () => [{ index: 0 }] };
                    },
                }),
            }),
            update,
        };
        db.transaction.mockImplementation(async (callback) =>
            callback(transaction),
        );
        const input = {
            sessionId: "session",
            userId: "owner",
            endedAt: new Date(),
            stopReason: "user",
            expectedChunkCount: 1,
            truncatedAtChunk: null,
            folderId,
        };
        expect(await markRecordingSessionCompleting(input)).toMatchObject({
            status: "completing",
            folderId: folderId === undefined ? "start" : folderId,
        });
        expect(
            await markRecordingSessionCompleting({
                ...input,
                folderId: "late",
            }),
        ).toBeNull();
        expect(update).toHaveBeenCalledOnce();
        expect(folder).toBe(folderId === undefined ? "start" : folderId);
    });
});
