import { expect, it } from "vitest";
import { compareNamesBySurname } from "@/lib/people/name-order";

const compare = compareNamesBySurname("cs-CZ");

it("sorts surnames using Czech collation, including Č and Ch", () => {
    expect(
        [
            "Adam Chalupa",
            "Petr Čermák",
            "Jan Hájek",
            "Eva Dvořák",
            "Zora Cibulka",
        ].sort(compare),
    ).toEqual([
        "Zora Cibulka",
        "Petr Čermák",
        "Eva Dvořák",
        "Jan Hájek",
        "Adam Chalupa",
    ]);
});

it("ignores suffixes, handles single words and falls back to the full name", () => {
    const names = [
        "  Ada   Zelená  ",
        "Petr Bureš (Acme, Inc.)",
        "Jan Novák, Ph.D.",
        "Čermák",
        "Adam Bureš",
    ];
    expect(names.sort(compare)).toEqual([
        "Adam Bureš",
        "Petr Bureš (Acme, Inc.)",
        "Čermák",
        "Jan Novák, Ph.D.",
        "  Ada   Zelená  ",
    ]);
    expect(compare("Petr Bureš (Acme)", "Čermák")).toBeLessThan(0);
});
