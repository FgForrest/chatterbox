import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/knowledge/knowledge-loader", () => ({ knowledgeView: vi.fn() }));
vi.mock("@/lib/knowledge/people", () => ({ findPersonByEmail: vi.fn() }));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: vi.fn() }));

import type { AlmanacUsageRow } from "@/db/queries/almanac-usage";
import type { KnowledgeView } from "@/lib/knowledge/knowledge-loader";
import type { KnownName } from "@/lib/knowledge/memory-store";
import { cleanTerm, rankAlmanacTerms } from "@/lib/transcription/almanac-terms";

type ViewItem = KnowledgeView["items"][number];

function item(
    id: string,
    name: string,
    names: Omit<KnownName, "target">[] = [],
    kind: "person" | "entity" = "entity",
): ViewItem {
    const target = kind === "person" ? { personId: id } : { entityId: id };
    return {
        id,
        kind,
        typeKey: kind === "person" ? "person" : "project",
        name,
        description: null,
        scope: "personal",
        notes: null,
        names: names.map((entry) => ({ ...entry, target })),
    };
}

function used(
    id: string,
    recent: number,
    total: number,
    lastAt = "2026-09-01T00:00:00Z",
): AlmanacUsageRow {
    return {
        personId: null,
        entityId: id,
        recent,
        total,
        lastAt: new Date(lastAt),
    };
}

const heard = (text: string, language: string | null = "cs") => ({
    kind: "heard_as" as const,
    text,
    language,
    provider: "ElevenLabs",
});
const alias = (text: string) => ({
    kind: "alias" as const,
    text,
    language: null,
    provider: null,
});

describe("cleanTerm", () => {
    it("drops characters providers refuse and collapses spaces", () => {
        expect(cleanTerm("  Orion <beta>  [x] ")).toBe("Orion beta x");
    });

    it("refuses a term too long or of too many words", () => {
        expect(cleanTerm("a".repeat(50))).toBeNull();
        expect(cleanTerm("a".repeat(49))).toBe("a".repeat(49));
        expect(cleanTerm("one two three four five six")).toBeNull();
        expect(cleanTerm("one two three four five")).toBe(
            "one two three four five",
        );
        expect(cleanTerm(" {} ")).toBeNull();
    });
});

describe("rankAlmanacTerms", () => {
    it("puts the recorder first, then recent use, then any use, then misheard records", () => {
        const terms = rankAlmanacTerms({
            items: [
                item("quiet", "Atlas"),
                item("misheard", "Zefira", [heard("Zefyra")]),
                item("old", "Borealis"),
                item("recent", "Orion"),
                item("me", "Jan Novák", [], "person"),
            ],
            usage: [used("old", 0, 7), used("recent", 2, 3)],
            recorderId: "me",
            language: "cs",
        });
        expect(terms.map((term) => term.text)).toEqual([
            "Jan Novák",
            "Orion",
            "Borealis",
            "Zefira",
            "Atlas",
        ]);
    });

    it("puts scope use after the recorder without changing the terms", () => {
        const items = [
            item("account", "Atlas"),
            item("scope-old", "Borealis"),
            item("scope-recent", "Orion"),
            item("me", "Jan Novák", [], "person"),
        ];
        const usage = [used("account", 9, 12)];
        const withoutScope = rankAlmanacTerms({
            items,
            usage,
            recorderId: "me",
            language: "cs",
        });
        const withScope = rankAlmanacTerms({
            items,
            usage,
            scopeUsage: [
                used("scope-old", 0, 8, "2026-01-01T00:00:00Z"),
                used("scope-recent", 2, 2, "2026-10-01T00:00:00Z"),
            ],
            recorderId: "me",
            language: "cs",
        });

        expect(withScope.map((term) => term.text)).toEqual([
            "Jan Novák",
            "Orion",
            "Borealis",
            "Atlas",
        ]);
        expect(withScope.map((term) => term.text).sort()).toEqual(
            withoutScope.map((term) => term.text).sort(),
        );
    });

    it("applies the cap after scope ranking", () => {
        const terms = rankAlmanacTerms({
            items: [
                item("account", "Atlas"),
                item("scope", "Borealis"),
                item("quiet", "Orion"),
            ],
            usage: [used("account", 5, 5)],
            scopeUsage: [used("scope", 1, 1)],
            recorderId: null,
            language: null,
            limit: 2,
        });

        expect(terms.map((term) => term.text)).toEqual(["Borealis", "Atlas"]);
    });

    it("gives misheard forms in the recording's language, and nicknames as terms", () => {
        const terms = rankAlmanacTerms({
            items: [
                item("z", "Zefira", [
                    heard("Zefyra", "cs-CZ"),
                    heard("Zephyra", "en"),
                    alias("Zef"),
                ]),
            ],
            usage: [],
            recorderId: null,
            language: "cs",
        });
        expect(terms).toEqual([
            { text: "Zefira", soundsLike: ["Zefyra"] },
            { text: "Zef", soundsLike: [] },
        ]);
    });

    it("keeps every misheard form when the language is not known", () => {
        const [term] = rankAlmanacTerms({
            items: [
                item("z", "Zefira", [
                    heard("Zefyra", "cs"),
                    heard("Zephyra", "en"),
                ]),
            ],
            usage: [],
            recorderId: null,
            language: null,
        });
        expect(term?.soundsLike).toEqual(["Zefyra", "Zephyra"]);
    });

    it("sends a name two records share once, and stops at the limit", () => {
        const terms = rankAlmanacTerms({
            items: [
                item("a", "Orion", [heard("Orian")]),
                item("b", "orion", [heard("Oryon")]),
                item("c", "Atlas"),
                item("d", "Borealis"),
            ],
            usage: [used("a", 3, 3), used("b", 2, 2)],
            recorderId: null,
            language: "cs",
            limit: 2,
        });
        expect(terms).toEqual([
            { text: "Orion", soundsLike: ["Orian", "Oryon"] },
            { text: "Atlas", soundsLike: [] },
        ]);
    });

    it("skips names no provider would take", () => {
        const terms = rankAlmanacTerms({
            items: [
                item("long", "The very long name of a committee here"),
                item("ok", "Orion"),
            ],
            usage: [],
            recorderId: null,
            language: null,
        });
        expect(terms.map((term) => term.text)).toEqual(["Orion"]);
    });
});
