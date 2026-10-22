import { describe, expect, it, vi } from "vitest";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import type { KnowledgeView } from "@/lib/knowledge/knowledge-loader";
import {
    rankAlmanacTerms,
    rankAlmanacTermsWithOverflow,
} from "@/lib/transcription/almanac-terms";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/knowledge/knowledge-loader", () => ({ knowledgeView: vi.fn() }));
vi.mock("@/lib/knowledge/people", () => ({ findPersonByEmail: vi.fn() }));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: vi.fn() }));

function item(
    id: string,
    name: string,
    aliases: string[] = [],
    heard = "",
): KnowledgeView["items"][number] {
    return {
        id,
        kind: "entity",
        typeKey: "project",
        name,
        description: null,
        scope: "personal",
        notes: null,
        names: [
            ...aliases.map((text) => ({
                kind: "alias" as const,
                text,
                language: null,
                provider: null,
                target: { entityId: id },
            })),
            ...(heard
                ? [
                      {
                          kind: "heard_as" as const,
                          text: heard,
                          language: "cs",
                          provider: null,
                          target: { entityId: id },
                      },
                  ]
                : []),
        ],
    };
}

describe("#240 folder knowledge ranking parity", () => {
    it("counts overflow without merging later duplicate mishearings into capped terms", () => {
        const input = {
            items: [
                item("a", "Velnaro", [], "velnah"),
                item("b", "Nulvaro"),
                item("c", "velnaro", [], "velnoh"),
                item("d", "Zulvra", ["Zulva", "Zulva"]),
            ],
            usage: [],
            scopeUsage: [],
            recorderId: "a",
            language: "cs",
            limit: 1,
        };
        const preview = rankAlmanacTermsWithOverflow(input);
        expect(
            preview.terms.map(({ text, soundsLike }) => ({ text, soundsLike })),
        ).toEqual(rankAlmanacTerms(input));
        expect(preview.terms[0]?.soundsLike).toEqual(["velnah"]);
        expect(preview.total).toBe(4);
        expect(preview.belowCut.map((term) => term.text)).toEqual([
            "Nulvaro",
            "Zulvra",
            "Zulva",
        ]);
    });
    it.each([
        0, 1, 2, 3, 500,
    ])("keeps same-record aliases and collisions identical at limit %s", (limit) => {
        const input = {
            items: [
                item("a", "Velnaro", ["Nulvaro", "Velnaro"], "velnah"),
                item("b", "Nulvaro", ["Zulvra"], "nulvah"),
            ],
            usage: [],
            recorderId: "a",
            language: "cs",
            limit,
        };
        const preview = rankAlmanacTermsWithOverflow(input);
        expect(
            preview.terms.map(({ text, soundsLike }) => ({ text, soundsLike })),
        ).toEqual(rankAlmanacTerms(input));
        expect(preview.total).toBe(3);
        expect(preview.belowCut).toHaveLength(Math.max(0, 3 - limit));
    });
});

describe("#240 folder knowledge plurals", () => {
    it.each([
        [
            0,
            "0 položek",
            "0 podsložek",
            "0 záznamů",
            "0 dalších jmen, přezdívek a pojmů",
        ],
        [
            1,
            "1 položka",
            "1 podsložky",
            "1 záznam",
            "1 další jméno, přezdívka nebo pojem",
        ],
        [
            3,
            "3 položky",
            "3 podsložek",
            "3 záznamy",
            "3 další jména, přezdívky a pojmy",
        ],
        [
            8,
            "8 položek",
            "8 podsložek",
            "8 záznamů",
            "8 dalších jmen, přezdívek a pojmů",
        ],
        [
            1.5,
            "1,5 položky",
            "1,5 podsložky",
            "1,5 záznamu",
            "1,5 dalšího jména, přezdívky nebo pojmu",
        ],
    ])("uses all Czech plural forms for %s", (count, items, folders, records, more) => {
        expect(
            translatedSourceMessage(
                "cs-CZ",
                "{items, plural, one {# item} other {# items}} including {folders, plural, one {# subfolder} other {# subfolders}}. Parent folders are not counted.",
                { items: count, folders: count },
            ),
        ).toBe(`${items} včetně ${folders}. Nadřazené složky se nepočítají.`);
        expect(
            translatedSourceMessage(
                "cs-CZ",
                "{count, plural, one {# record} other {# records}}; exact preview of the first {preview, plural, one {# record} other {# records}}.",
                { count, preview: 1 },
            ),
        ).toBe(`${records}; přesný náhled prvního 1 záznamu.`);
        expect(
            translatedSourceMessage(
                "cs-CZ",
                "… {count, plural, one {# more name, alias or term} other {# more names, aliases and terms}}",
                { count },
            ),
        ).toBe(`… ${more}`);
    });
    it.each([
        0, 1, 2,
    ])("pluralizes English results and mishearings for %s", (count) => {
        expect(
            translatedSourceMessage(
                "en",
                "{count, plural, one {# result} other {# results}}",
                { count },
            ),
        ).toBe(`${count} result${count === 1 ? "" : "s"}`);
        expect(
            translatedSourceMessage(
                "en",
                "{count, plural, one {# mishearing} other {# mishearings}}",
                { count },
            ),
        ).toBe(`${count} mishearing${count === 1 ? "" : "s"}`);
    });
});
