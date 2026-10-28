import { describe, expect, it } from "vitest";
import { suggestionLanguage } from "@/lib/meetings/suggestion-language";

describe("suggestion language", () => {
    const items = [
        { itemId: "one", language: "cs" },
        { itemId: "two", language: "cs-CZ" },
        { itemId: "three", language: "en" },
    ];
    it("preserves an explicit profile language", () => {
        expect(suggestionLanguage("de", items, "cs-CZ")).toBe("de");
    });
    it("uses the dominant source language ahead of the UI locale", () => {
        expect(suggestionLanguage("auto", items, "en")).toBe("cs");
    });
    it("handles mail and recording languages equally and does not count duplicate item summaries", () => {
        expect(
            suggestionLanguage(
                "auto",
                [
                    ...items,
                    ...Array.from({ length: 5 }, () => ({
                        itemId: "three",
                        language: "en",
                    })),
                ],
                "en",
            ),
        ).toBe("cs");
        expect(
            suggestionLanguage(
                "auto",
                [{ itemId: "mail", language: "fr" }],
                "cs-CZ",
            ),
        ).toBe("fr");
    });
    it("uses the captured browser-resolved locale when source languages are unknown", () => {
        expect(
            suggestionLanguage(
                "auto",
                [
                    { itemId: "one", language: null },
                    { itemId: "two", language: "und" },
                ],
                "cs-CZ",
            ),
        ).toBe("cs");
        expect(suggestionLanguage("auto", [], "cs-CZ")).toBe("cs");
    });
    it("uses English last and resolves ties in source order", () => {
        expect(suggestionLanguage("auto", [], null)).toBe("en");
        expect(suggestionLanguage("auto", items.slice(1), "en")).toBe("cs");
    });
});
