import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: {} }));

import {
    type Candidate,
    decideMatch,
    echoResolved,
    resolvedSchema,
} from "@/lib/mcp/resolve";

function candidate(id: string, score: number, exact = score === 1): Candidate {
    return { id, name: `Name ${id}`, typeKey: "person", score, exact };
}

describe("decideMatch", () => {
    it("takes the only exact candidate", () => {
        expect(decideMatch([candidate("a", 0.95), candidate("b", 1)])).toEqual({
            kind: "match",
            candidate: candidate("b", 1),
        });
    });

    it("calls two exact candidates ambiguous, listing those", () => {
        const decision = decideMatch([
            candidate("a", 1),
            candidate("b", 0.95),
            candidate("c", 1),
        ]);
        expect(decision).toEqual({
            kind: "ambiguous",
            candidates: [candidate("a", 1), candidate("c", 1)],
        });
    });

    it("takes a top candidate well ahead", () => {
        expect(decideMatch([candidate("a", 0.9)])).toEqual({
            kind: "match",
            candidate: candidate("a", 0.9),
        });
        expect(
            decideMatch([candidate("b", 0.7), candidate("a", 0.9)]),
        ).toMatchObject({ kind: "match", candidate: { id: "a" } });
    });

    it("calls close scores ambiguous", () => {
        expect(decideMatch([candidate("a", 0.9), candidate("b", 0.8)])).toEqual(
            {
                kind: "ambiguous",
                candidates: [candidate("a", 0.9), candidate("b", 0.8)],
            },
        );
    });

    it("calls a weak lone candidate ambiguous rather than guessing", () => {
        expect(decideMatch([candidate("a", 0.7)])).toEqual({
            kind: "ambiguous",
            candidates: [candidate("a", 0.7)],
        });
    });

    it("lists at most five candidates, best first", () => {
        const many = [0.5, 0.6, 0.85, 0.8, 0.7, 0.75, 0.65].map((score, i) =>
            candidate(`c${i}`, score),
        );
        const decision = decideMatch(many);
        expect(decision.kind).toBe("ambiguous");
        if (decision.kind !== "ambiguous") return;
        expect(decision.candidates.map((c) => c.score)).toEqual([
            0.85, 0.8, 0.75, 0.7, 0.65,
        ]);
    });

    it("finds nothing in nothing", () => {
        expect(decideMatch([])).toEqual({ kind: "none" });
    });
});

describe("echoResolved", () => {
    it("echoes a reference given as text", () => {
        const echo = echoResolved("jan", {
            id: "p1",
            name: "Jan Novotný",
            matchedBy: "token",
        });
        expect(echo).toEqual({
            input: "jan",
            id: "p1",
            name: "Jan Novotný",
            matched_by: "token",
        });
        expect(resolvedSchema.parse(echo)).toEqual(echo);
        expect(
            echoResolved("pricing", {
                id: "r1",
                title: "Pricing call",
                matchedBy: "words",
            }),
        ).toMatchObject({ name: "Pricing call", matched_by: "words" });
    });

    it("says nothing for an id", () => {
        expect(
            echoResolved("p1", { id: "p1", name: "Jan", matchedBy: "id" }),
        ).toBeUndefined();
    });
});
