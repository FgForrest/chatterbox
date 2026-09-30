import { describe, expect, it } from "vitest";
import {
    parseImportList,
    resolveImportType,
} from "@/lib/knowledge/import-list-parse";

const TYPES = [
    { key: "person", label: "Person" },
    { key: "organization", label: "Organization" },
    { key: "product", label: "Product or system" },
    { key: "vendor", label: "Dodavatel" },
];

describe("reading a pasted list", () => {
    it("reads names, their nicknames and their line, skipping comments", () => {
        const { names, problems } = parseImportList(
            [
                "# comment",
                "",
                "product: Alpha, Beta (Béta, B2); Gamma ( G )",
                "  person:  Jana  Nováková (Janička) ",
            ].join("\n"),
        );
        expect(names).toEqual([
            { line: 3, typeText: "product", name: "Alpha", nicknames: [] },
            {
                line: 3,
                typeText: "product",
                name: "Beta",
                nicknames: ["Béta", "B2"],
            },
            { line: 3, typeText: "product", name: "Gamma", nicknames: ["G"] },
            {
                line: 4,
                typeText: "person",
                name: "Jana Nováková",
                nicknames: ["Janička"],
            },
        ]);
        expect(problems).toEqual([]);
    });

    it("says which lines it could not read", () => {
        const { names, problems } = parseImportList(
            "no colon here\nproduct:\n: Alpha\nproduct: (only a nickname)\nproduct: Alpha (A) more",
        );
        expect(names).toEqual([]);
        expect(problems.map((problem) => problem.line)).toEqual([
            1, 2, 3, 4, 5,
        ]);
    });

    it("knows a type by its key, its label, a plural or its Czech name", () => {
        expect(resolveImportType("Product", TYPES)).toBe("product");
        expect(resolveImportType("product or system", TYPES)).toBe("product");
        expect(resolveImportType("products", TYPES)).toBe("product");
        expect(resolveImportType("Organizace", TYPES)).toBe("organization");
        expect(resolveImportType("osoby", TYPES)).toBe("person");
        expect(resolveImportType("dodavatel", TYPES)).toBe("vendor");
        expect(resolveImportType("planet", TYPES)).toBeNull();
        // A core word for a type this vocabulary lacks is not a match.
        expect(resolveImportType("projekt", TYPES)).toBeNull();
    });
});
