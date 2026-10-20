import { describe, expect, it } from "vitest";
import { matchText, prepareQuery, snippets } from "@/lib/mcp/text-search";

function find(text: string, query: string, language: string | null = null) {
    return matchText(text, prepareQuery(query, language), language);
}

describe("matchText", () => {
    it("meets a Czech inflected form through its stems", () => {
        const text = "Pošli to Novákovi zítra.";
        const hits = find(text, "novak", "cs");
        expect(hits).not.toBeNull();
        expect(hits?.map((hit) => text.slice(hit.start, hit.end))).toEqual([
            "Novákovi",
        ]);
        expect(find(text, "novak")).toBeNull();
    });

    it("ignores case and accents", () => {
        expect(find("PRICING review", "pricing")).toEqual([
            { start: 0, end: 7 },
        ]);
        expect(find("Schůzka v Brně", "schuzka brne")).toHaveLength(2);
    });

    it("needs every word of the query", () => {
        expect(find("pricing and budget", "pricing budget")).toHaveLength(2);
        expect(find("pricing only", "pricing budget")).toBeNull();
    });

    it("lists every occurrence in text order", () => {
        const text = "budget, then pricing, then budget again";
        expect(
            find(text, "pricing budget")?.map((hit) =>
                text.slice(hit.start, hit.end),
            ),
        ).toEqual(["budget", "pricing", "budget"]);
    });

    it("matches nothing for a query without words", () => {
        expect(prepareQuery(" ,.! ", null)).toEqual([]);
        expect(find("anything at all", " ,.! ")).toBeNull();
    });

    it("keeps offsets on text written with combining marks", () => {
        const text = "Základní plan";
        const hits = find(text, "zakladni");
        expect(hits?.map((hit) => text.slice(hit.start, hit.end))).toEqual([
            "Základní",
        ]);
    });
});

describe("snippets", () => {
    const word = (index: number) => `w${String(index).padStart(3, "0")}`;
    const text = Array.from({ length: 200 }, (_, i) => word(i)).join(" ");
    const at = (index: number) => {
        const start = text.indexOf(word(index));
        return { start, end: start + 4 };
    };

    it("caps at three", () => {
        const out = snippets(text, [at(10), at(60), at(110), at(160)]);
        expect(out).toHaveLength(3);
        expect(out[0]).toContain(word(10));
        expect(out[2]).toContain(word(110));
    });

    it("never repeats text between excerpts", () => {
        const out = snippets(text, [at(10), at(12), at(30), at(31)], 5, 20);
        expect(out).toHaveLength(2);
        expect(out[0]).toContain(word(10));
        expect(out[1]).toContain(word(30));
        const [first, second] = out;
        const tail = first?.replaceAll("…", "").trim().split(" ").at(-1) ?? "";
        expect(second?.replaceAll("…", "").includes(tail)).toBe(false);
    });

    it("marks where it cut", () => {
        expect(snippets("short text", [{ start: 0, end: 5 }])).toEqual([
            "short text",
        ]);
        const [middle] = snippets(text, [at(100)], 1, 10);
        expect(middle?.startsWith("…")).toBe(true);
        expect(middle?.endsWith("…")).toBe(true);
    });

    it("cuts at whitespace boundaries and keeps the excerpt literal", () => {
        const prose = `${"amber lanterns shimmer gently ".repeat(12)}needle ${"violet ribbons flutter softly ".repeat(12)}`;
        const out = snippets(prose, find(prose, "needle") ?? [], 3, 37);
        expect(out).toHaveLength(1);
        for (const snippet of out) {
            const literal = snippet.replace(/^…|…$/g, "");
            const start = prose.indexOf(literal);
            const end = start + literal.length;
            expect(start).toBeGreaterThanOrEqual(0);
            expect(start === 0 || /\s/u.test(prose[start - 1])).toBe(true);
            expect(end === prose.length || /\s/u.test(prose[end])).toBe(true);
        }
    });

    it("merges touching windows even after reaching the snippet count", () => {
        const hits = [at(50), at(70)];
        const out = snippets(text, hits, 1, 48);
        expect(out).toHaveLength(1);
        expect(out[0]).toContain(word(50));
        expect(out[0]).toContain(word(70));
    });

    it("merges windows separated by a small gap", () => {
        const out = snippets(text, [at(50), at(60)], 3, 20);
        expect(out).toHaveLength(1);
        expect(out[0]).toContain(word(50));
        expect(out[0]).toContain(word(60));
    });

    it("keeps distant hits in separate snippets", () => {
        const out = snippets(text, [at(20), at(170)], 3, 37);
        expect(out).toHaveLength(2);
        expect(out[0]).toContain(word(20));
        expect(out[1]).toContain(word(170));
        expect(out[0]).not.toContain(word(170));
    });

    it("caps merging and starts another snippet at a word boundary", () => {
        const out = snippets(text, [at(20), at(26), at(32), at(38)], 3, 20);
        expect(out.length).toBeGreaterThan(1);
        for (const snippet of out) {
            const literal = snippet.replace(/^…|…$/g, "");
            expect(literal.length).toBeLessThanOrEqual(2 * (40 + 4 + 8));
            expect(literal).toMatch(/^w\d{3}(?: w\d{3})*$/);
        }
        for (const index of [20, 26, 32, 38])
            expect(out.some((snippet) => snippet.includes(word(index)))).toBe(
                true,
            );
    });

    it("does not extend through an unbroken token beyond the boundary allowance", () => {
        const prose = `${"x".repeat(200)} needle ${"y".repeat(200)}`;
        expect(snippets(prose, find(prose, "needle") ?? [], 3, 40)).toEqual([
            "…needle…",
        ]);
    });

    it("keeps a hit inside a long unbroken token, cut mid-word", () => {
        const link = `https://example.cz/${"a".repeat(150)}/needle/${"b".repeat(150)}`;
        const prose = `See ${link} today`;
        const [only] = snippets(prose, find(prose, "needle") ?? [], 3, 40);
        expect(only).toContain("needle");
        expect(prose).toContain(only?.replace(/^…|…$/g, "") ?? "");
    });
});
