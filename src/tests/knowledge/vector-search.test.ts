import { describe, expect, it } from "vitest";
import {
    buildMatrix,
    decodeVector,
    encodeVector,
    topK,
} from "@/lib/knowledge/vector-search";

const unit = (...values: number[]) => {
    const length = Math.hypot(...values);
    return Float32Array.from(values.map((value) => value / length));
};

describe("vector search", () => {
    const alice = buildMatrix("alice", [
        { id: "orion", kind: "entity", vector: unit(1, 0, 0) },
        { id: "tavesi", kind: "entity", vector: unit(0, 1, 0) },
        { id: "fact-1", kind: "fact", vector: unit(1, 1, 0) },
    ]);
    const org = buildMatrix("org", [
        { id: "acme", kind: "entity", vector: unit(0, 0, 1) },
        { id: "orion-crm", kind: "entity", vector: unit(0.9, 0.1, 0) },
    ]);

    it("ranks by cosine across the scopes searched, best first", () => {
        const found = topK(unit(1, 0.05, 0), [alice, org], 3);
        expect(found.map((hit) => hit.id)).toEqual([
            "orion",
            "orion-crm",
            "fact-1",
        ]);
        expect(found[1]).toMatchObject({ scope: "org", kind: "entity" });
        expect(found[0]?.score ?? 0).toBeGreaterThan(found[1]?.score ?? 0);
    });

    it("keeps to k, and to the floor", () => {
        expect(topK(unit(1, 0, 0), [alice, org], 1)).toHaveLength(1);
        expect(
            topK(unit(0, 0, 1), [alice, org], 5, 0.5).map((hit) => hit.id),
        ).toEqual(["acme"]);
    });

    it("skips a matrix of another dimension, and finds nothing in none", () => {
        const other = buildMatrix("other", [
            { id: "x", kind: "entity", vector: unit(1, 0) },
        ]);
        expect(topK(unit(1, 0, 0), [other], 3)).toEqual([]);
        expect(topK(unit(1, 0, 0), [], 3)).toEqual([]);
        expect(buildMatrix("empty", []).rows).toBe(0);
    });

    it("stores a vector as text and reads it back unchanged", () => {
        const vector = unit(0.25, -0.5, 0.75, 0.1);
        expect(Array.from(decodeVector(encodeVector(vector)))).toEqual(
            Array.from(vector),
        );
    });
});
