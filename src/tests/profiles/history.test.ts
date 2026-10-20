import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileHistoryReferences } from "@/db/queries/profile-history";
import { itemProcessing, transcriptions } from "@/db/schema";

const { decryptTopics } = vi.hoisted(() => ({
    decryptTopics: vi.fn((value: unknown) => value),
}));
vi.mock("@/lib/encryption/fields", () => ({ decryptJsonField: decryptTopics }));

type Row = { id: string; topics?: { profileRevisionId: string } };

function queries(results: Row[][]) {
    const calls: {
        table?: unknown;
        where?: SQL;
        limit?: number;
        order?: unknown[];
    }[] = [];
    const executor = {
        select: vi.fn(() => {
            const call: (typeof calls)[number] = {};
            calls.push(call);
            const rows = results.shift() ?? [];
            const result = Promise.resolve(rows);
            const builder = Object.assign(result, {
                from(table: unknown) {
                    call.table = table;
                    return result;
                },
                innerJoin() {
                    return result;
                },
                where(where: SQL) {
                    call.where = where;
                    return result;
                },
                orderBy(...order: unknown[]) {
                    call.order = order;
                    return result;
                },
                limit(limit: number) {
                    call.limit = limit;
                    return result;
                },
            });
            return builder;
        }),
    };
    return {
        executor: executor as unknown as Parameters<
            typeof profileHistoryReferences
        >[0],
        calls,
    };
}

describe("profile history query costs", () => {
    beforeEach(() => decryptTopics.mockClear());

    it("returns from the indexed assignment check without reading output or topics rows", async () => {
        const { executor, calls } = queries([
            [{ id: "revision" }],
            [{ id: "item" }],
        ]);
        expect(
            await profileHistoryReferences(executor, "owner", "profile"),
        ).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[1]?.table).toBe(itemProcessing);
        const condition = calls[1]?.where;
        if (!condition) throw new Error("Missing assignment condition");
        expect(new PgDialect().sqlToQuery(condition).sql).toContain(
            '"item_processing"."profile_id"',
        );
        expect(decryptTopics).not.toHaveBeenCalled();
    });

    it.each([
        2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])("stops after reference check %i, before decrypting topics", async (match) => {
        const results: Row[][] = Array.from({ length: match + 1 }, () => []);
        results[0] = [{ id: "revision" }];
        results[match] = [{ id: "reference" }];
        const { executor, calls } = queries(results);
        expect(
            await profileHistoryReferences(executor, "owner", "profile"),
        ).toBe(true);
        expect(calls).toHaveLength(match + 1);
        expect(decryptTopics).not.toHaveBeenCalled();
    });

    it.each([
        true,
        false,
    ])("scopes JSON and topics to the owner and keyset-pages topics; match=%s", async (match) => {
        const first = Array.from({ length: 100 }, (_, id) => ({
            id: String(id).padStart(3, "0"),
            topics: { profileRevisionId: "other" },
        }));
        const { executor, calls } = queries([
            [{ id: "revision" }],
            ...Array.from({ length: 10 }, () => []),
            first,
            [
                {
                    id: "100",
                    topics: { profileRevisionId: match ? "revision" : "other" },
                },
            ],
        ]);
        expect(
            await profileHistoryReferences(executor, "owner", "profile"),
        ).toBe(match);
        const dialect = new PgDialect();
        const phaseCondition = calls[10]?.where;
        const topicsCondition = calls[12]?.where;
        if (!phaseCondition || !topicsCondition)
            throw new Error("Missing metadata conditions");
        const phase = dialect.sqlToQuery(phaseCondition);
        expect(phase.params).toContain("owner");
        expect(phase.sql).toContain('"item_processing"."user_id"');
        expect(phase.sql).not.toContain('"item_processing"."profile_id"');
        expect(calls.slice(11).map((call) => call.limit)).toEqual([100, 100]);
        expect(
            calls
                .slice(11)
                .every(
                    (call) =>
                        call.table === transcriptions &&
                        call.order?.length === 1,
                ),
        ).toBe(true);
        const second = dialect.sqlToQuery(topicsCondition);
        expect(second.params).toEqual(["owner", "099"]);
        expect(decryptTopics).toHaveBeenCalledTimes(101);
    });
});
