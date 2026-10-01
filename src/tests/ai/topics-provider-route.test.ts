import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
vi.mock("@/db", () => ({
    db: { select: vi.fn(), transaction: vi.fn() },
}));

import {
    DELETE as clearDefaultTopics,
    PUT as setDefaultTopics,
} from "@/app/api/settings/ai/providers/default-topics/route";
import { db } from "@/db";

const dialect = new PgDialect();
const url = "https://app.example.com/api/settings/ai/providers/default-topics";

function putRequest(providerId: string) {
    return new Request(url, {
        method: "PUT",
        body: JSON.stringify({ providerId }),
    });
}

function queueProvider(rows: unknown[]) {
    const where = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
    });
    (db.select as Mock).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where }),
    });
    return where;
}

function queueTransaction(preferences: Record<string, unknown> | null) {
    const lock = vi.fn().mockResolvedValue([{ id: "user-1" }]);
    const readSettings = vi.fn().mockReturnValue({
        limit: vi
            .fn()
            .mockResolvedValue(preferences === null ? [] : [{ preferences }]),
    });
    const values = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const set = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
        select: vi
            .fn()
            .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({ for: lock }),
                }),
            })
            .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({ where: readSettings }),
            }),
        insert: vi.fn().mockReturnValue({ values }),
        update: vi.fn().mockReturnValue({ set }),
    };
    (db.transaction as Mock).mockImplementationOnce(
        async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    );
    return { lock, readSettings, values, set };
}

describe("Topics provider preference route", () => {
    beforeEach(() => vi.clearAllMocks());

    it("rejects a provider outside the signed-in user's credentials", async () => {
        const where = queueProvider([]);

        const response = await setDefaultTopics(putRequest("cred-other"));

        expect(response.status).toBe(404);
        expect(db.transaction).not.toHaveBeenCalled();
        const query = dialect.sqlToQuery(where.mock.calls[0][0]);
        expect(query.sql).toContain('"api_credentials"."user_id"');
        expect(query.params).toEqual(["cred-other", "user-1"]);
    });

    it("rejects a transcription-only provider", async () => {
        queueProvider([{ provider: "ElevenLabs" }]);

        const response = await setDefaultTopics(putRequest("cred-1"));

        expect(response.status).toBe(400);
        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("sets Topics while preserving other provider preferences", async () => {
        queueProvider([{ provider: "OpenAI" }]);
        const tx = queueTransaction({
            summary: "cred-summary",
            learn: "cred-learn",
        });

        const response = await setDefaultTopics(putRequest("cred-topics"));

        expect(response.status).toBe(200);
        expect(tx.lock).toHaveBeenCalledWith("update");
        expect(tx.values).toHaveBeenCalledWith({
            userId: "user-1",
            defaultProviders: {
                summary: "cred-summary",
                learn: "cred-learn",
                topics: "cred-topics",
            },
        });
    });

    it("clears only Topics and preserves other provider preferences", async () => {
        const tx = queueTransaction({
            summary: "cred-summary",
            learn: "cred-learn",
            topics: "cred-topics",
        });

        const response = await clearDefaultTopics(
            new Request(url, { method: "DELETE" }),
        );

        expect(response.status).toBe(200);
        expect(tx.lock).toHaveBeenCalledWith("update");
        expect(tx.set).toHaveBeenCalledWith({
            defaultProviders: {
                summary: "cred-summary",
                learn: "cred-learn",
            },
            updatedAt: expect.any(Date),
        });
    });
});
