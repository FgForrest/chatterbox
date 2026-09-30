/**
 * Load test of the knowledge memory store, meant for Bun (production runs
 * `bun server.js`): 50,000 items over an Organization scope and several
 * private ones, loaded, searched by name and evicted under a limit smaller
 * than all of them.
 *
 *   bun scripts/knowledge-memory-load.ts
 *
 * No database: the loader makes up the scopes. Prints the store's own
 * estimate beside the heap it really took, the time a name search over
 * 50,000 items takes, and what eviction did.
 */

import {
    KnowledgeMemoryStore,
    type LoadedScope,
} from "../src/lib/knowledge/memory-store";


const TOTAL_ITEMS = 50_000;
const ORG_ITEMS = 10_000;
const PRIVATE_SCOPES = 8;
const PER_PRIVATE = (TOTAL_ITEMS - ORG_ITEMS) / PRIVATE_SCOPES;

const FIRST = ["Jan", "Petra", "Łukasz", "Иван", "Νίκος", "Jürgen", "Anna"];
const LAST = ["Novotný", "Dvořák", "Kowalski", "Иванов", "Παπαδόπουλος", "Müller"];

function makeScope(scope: string, count: number): LoadedScope {
    const items = Array.from({ length: count }, (_, i) => ({
        id: `${scope}-${i.toString(36).padStart(6, "0")}`,
        kind: (i % 3 === 0 ? "entity" : "person") as "entity" | "person",
        typeKey: i % 3 === 0 ? "project" : "person",
        name: `${FIRST[i % FIRST.length]} ${LAST[(i >> 3) % LAST.length]} ${i}`,
        description: i % 5 === 0 ? `Description of item ${i} in ${scope}` : null,
    }));
    return {
        items,
        names: items
            .filter((_, i) => i % 4 === 0)
            .map((item) => ({
                target: { personId: item.id },
                kind: "alias" as const,
                text: `${item.name.split(" ")[0]}ík`,
                language: "cs",
                provider: null,
            })),
        notes: new Map(),
        facts: items
            .filter((_, i) => i % 2 === 0)
            .map((item, i) => ({
                id: `${item.id}-f`,
                subject: { personId: item.id },
                relationKey: "works_on",
                object: { entityId: items[(i * 7) % items.length]?.id ?? "" },
                origin: "recording" as const,
            })),
    };
}

function heapMb(): number {
    Bun?.gc?.(true);
    return process.memoryUsage().heapUsed / 1024 / 1024;
}

declare const Bun: { gc?: (force: boolean) => void; version: string } | undefined;

async function main(): Promise<void> {
    const scopes = [
        "org",
        ...Array.from({ length: PRIVATE_SCOPES }, (_, i) => `user-${i}`),
    ];
    const generations = new Map(scopes.map((scope) => [scope, 1]));
    const logs: string[] = [];

    // Unbounded first: what 50,000 items really take.
    const unbounded = new KnowledgeMemoryStore({
        load: async (scope) =>
            makeScope(scope, scope === "org" ? ORG_ITEMS : PER_PRIVATE),
        readGenerations: async (asked) =>
            new Map(asked.map((scope) => [scope, generations.get(scope) ?? 0])),
        maxBytes: Number.MAX_SAFE_INTEGER,
    });
    const before = heapMb();
    let started = performance.now();
    const all = await unbounded.get(scopes);
    const loadMs = performance.now() - started;
    const after = heapMb();
    const estimate = unbounded.stats().bytes / 1024 / 1024;

        const queries = ["Honzík", "Novotny", "Ivanov", "Nikos Papadopoulos", "Kubernetes"];
    started = performance.now();
    let found = 0;
    for (const query of queries) {
        for (const held of all) found += held.index.match(query).length;
    }
    const searchMs = (performance.now() - started) / queries.length;

    // Bounded to a third of it: cycle through the scopes as requests would.
    const limit = Math.floor(unbounded.stats().bytes / 3);
    const bounded = new KnowledgeMemoryStore({
        load: async (scope) =>
            makeScope(scope, scope === "org" ? ORG_ITEMS : PER_PRIVATE),
        readGenerations: async (asked) =>
            new Map(asked.map((scope) => [scope, generations.get(scope) ?? 0])),
        maxBytes: limit,
        pinnedScope: () => "org",
        log: (message) => logs.push(message),
    });
    for (let round = 0; round < 3; round++) {
        for (const scope of scopes.slice(1)) {
            await bounded.get(["org", scope]);
        }
    }
    const stats = bounded.stats();
    const orgKept = logs.every((line) => !line.includes("org"));

    console.log(
        JSON.stringify(
            {
                runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
                items: all.reduce((sum, held) => sum + held.items.length, 0),
                loadMs: Math.round(loadMs),
                heapMb: Math.round(after - before),
                estimateMb: Math.round(estimate),
                searchMsPerQuery: Math.round(searchMs),
                matches: found,
                bounded: {
                    limitMb: Math.round(limit / 1024 / 1024),
                    heldScopes: stats.scopes,
                    heldMb: Math.round(stats.bytes / 1024 / 1024),
                    loads: stats.loads,
                    hits: stats.hits,
                    evictions: stats.evictions,
                    orgNeverEvicted: orgKept,
                },
            },
            null,
            2,
        ),
    );
}

await main();
