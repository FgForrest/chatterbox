import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/encryption", () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { listRecordingSessionsForUser } from "../../lib/recording-sessions/store";

describe("recorder session listing", () => {
    it("filters by both owner and recorder API key", async () => {
        let condition;
        mockDb.select.mockReturnValue({
            from: () => ({
                where: (where) => {
                    condition = where;
                    return { orderBy: () => ({ limit: async () => [] }) };
                },
            }),
        });

        expect(
            await listRecordingSessionsForUser("user-1", "key-1", {
                limit: 25,
            }),
        ).toEqual([]);
        const query = new PgDialect().sqlToQuery(condition);
        expect(query.sql).toContain('"recording_sessions"."user_id"');
        expect(query.sql).toContain('"recording_sessions"."api_key_id"');
        expect(query.params).toEqual(["user-1", "key-1"]);
    });
});
