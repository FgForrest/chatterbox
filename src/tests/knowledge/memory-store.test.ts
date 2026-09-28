import { beforeEach, describe, expect, it } from "vitest";
import {
    KnowledgeMemoryStore,
    type LoadedScope,
} from "@/lib/knowledge/memory-store";

function scopeOf(scope: string, items = 1, nameLength = 10): LoadedScope {
    return {
        items: Array.from({ length: items }, (_, i) => ({
            id: `${scope}-${i}`,
            kind: "entity" as const,
            typeKey: "project",
            name: "x".repeat(nameLength),
            description: null,
        })),
        names: [],
        notes: new Map(),
        facts: [],
    };
}

describe("KnowledgeMemoryStore", () => {
    let generations: Map<string, number>;
    let loads: string[];
    let clock: number;
    let sizes: Map<string, number>;

    function store(maxBytes = 1_000_000, pinned: string | null = null) {
        return new KnowledgeMemoryStore({
            load: async (scope) => {
                loads.push(scope);
                return scopeOf(scope, sizes.get(scope) ?? 1);
            },
            readGenerations: async (scopes) =>
                new Map(scopes.map((s) => [s, generations.get(s) ?? 0])),
            maxBytes,
            ttlMs: 60_000,
            pinnedScope: () => pinned,
            now: () => clock,
        });
    }

    beforeEach(() => {
        generations = new Map([
            ["alice", 1],
            ["org", 1],
        ]);
        loads = [];
        clock = 0;
        sizes = new Map();
    });

    it("loads a scope once, and again only when its generation moves", async () => {
        const knowledge = store();
        await knowledge.get(["alice", "org"]);
        await knowledge.get(["alice", "org"]);
        expect(loads.sort()).toEqual(["alice", "org"]);

        generations.set("alice", 2);
        const [alice] = await knowledge.get(["alice"]);
        expect(loads).toHaveLength(3);
        expect(alice?.generation).toBe(2);
        expect(knowledge.stats()).toMatchObject({ hits: 2, loads: 3 });
    });

    it("loads a scope once for everyone asking at the same time", async () => {
        const knowledge = store();
        await Promise.all([
            knowledge.get(["alice"]),
            knowledge.get(["alice"]),
            knowledge.get(["alice"]),
        ]);
        expect(loads).toEqual(["alice"]);
    });

    it("drops a scope whose generation is gone with its account", async () => {
        const knowledge = store();
        await knowledge.get(["alice"]);
        generations.delete("alice");
        await knowledge.get(["alice"]);
        expect(knowledge.stats().dropped).toBe(1);
        expect(loads).toEqual(["alice", "alice"]);
    });

    it("reloads a scope marked stale, or old, whatever its generation", async () => {
        const knowledge = store();
        await knowledge.get(["alice"]);
        knowledge.markStale("alice");
        await knowledge.get(["alice"]);
        expect(loads).toHaveLength(2);

        clock = 61_000;
        await knowledge.get(["alice"]);
        expect(loads).toHaveLength(3);
    });

    it("forgets everything when the listener is lost", async () => {
        const knowledge = store();
        await knowledge.get(["alice", "org"]);
        knowledge.invalidateAll();
        expect(knowledge.stats()).toMatchObject({ scopes: 0, bytes: 0 });
        await knowledge.get(["alice"]);
        expect(loads.filter((scope) => scope === "alice")).toHaveLength(2);
    });

    it("evicts the least recently used past its limit, the Organization last, never one in use", async () => {
        for (const scope of ["a", "b", "c"]) generations.set(scope, 1);
        sizes = new Map([
            ["org", 10],
            ["a", 10],
            ["b", 10],
            ["c", 10],
        ]);
        const oneScope = (await store().get(["a"]))[0]?.bytes ?? 0;
        const knowledge = store(oneScope * 2.5, "org");

        await knowledge.get(["org"]);
        await knowledge.get(["a"]);
        await knowledge.get(["b"]);
        // Over the limit: `a` goes first; `org` is older but pinned.
        expect(knowledge.stats()).toMatchObject({ scopes: 2, evictions: 1 });
        loads = [];
        await knowledge.get(["org", "b"]);
        expect(loads).toEqual([]);

        // Two in use at once may exceed the limit; nothing in use goes.
        await knowledge.get(["c", "b", "a"]);
        expect(knowledge.stats().scopes).toBe(3);
    });
});
