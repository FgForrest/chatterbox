import { describe, expect, it } from "vitest";
import {
    type DuplicateRecord,
    duplicateNameForms,
    duplicateNameIndex,
    proposedSurvivor,
    rankDuplicateRecords,
    scoreDuplicate,
} from "@/lib/knowledge/duplicate-score";

function record(
    id: string,
    name: string,
    overrides: Partial<DuplicateRecord> = {},
): DuplicateRecord {
    return {
        id,
        name,
        kind: "person",
        typeKey: "person",
        primaryEmail: null,
        emails: [],
        aliases: [],
        heardAs: [],
        evidenceCount: 0,
        ...overrides,
    };
}

describe("Organization duplicate scorer", () => {
    it.each([
        ["Ondra Kalous", "Ondřej Kalous", "nickname"],
        ["Honza Kalous", "Jan Kalous", "nickname"],
        ["Bill Kalous", "William Kalous", "nickname"],
        ["Petra Lindová", "Petra Lind", "surname_form"],
        ["Petra Lindová", "Petra Linda", "surname_form"],
        ["Petra Lindová", "Petra Lindova", "equal_name"],
        ["Ondřej Kalous", "Ondřej Kalus", "typo"],
        ["Kalous Research", "Kalous Researches", "similar_name"],
    ])("finds %s / %s via %s and retrieves it through NameIndex", (leftName, rightName, signal) => {
        const left = record("left", leftName);
        const right = record("right", rightName);
        expect(scoreDuplicate(left, right)?.for).toContain(signal);
        expect(
            duplicateNameForms(left)
                .flatMap((form) => duplicateNameIndex([right]).match(form))
                .some((match) => match.id === right.id),
        ).toBe(true);
    });

    it.each([
        "a.s.",
        "s.r.o.",
        "spol. s r.o.",
        "Ltd",
        "Inc.",
        "GmbH",
    ])("strips %s from entity names", (suffix) => {
        const left = record("left", "Kestrel Energo", {
            kind: "entity",
            typeKey: "organization",
        });
        const right = record("right", `Kestrel Energo ${suffix}`, {
            kind: "entity",
            typeKey: "organization",
        });
        expect(scoreDuplicate(left, right)).toMatchObject({
            confidence: "high",
            for: expect.arrayContaining(["legal_form"]),
        });
    });

    it("finds the same name under two entity types", () => {
        expect(
            scoreDuplicate(
                record("a", "Kestrel", { kind: "entity", typeKey: "project" }),
                record("b", "Kestrel", { kind: "entity", typeKey: "product" }),
            )?.for,
        ).toContain("different_types");
    });
    it("uses heard-as forms and aliases in either direction", () => {
        const left = record("a", "Ondřej Kalous", {
            heardAs: ["Zim Keral"],
            aliases: ["Kalo"],
        });
        for (const [name, signal] of [
            ["Zim Keral", "heard_as"],
            ["Kalo", "alias"],
        ]) {
            const right = record("b", name);
            expect(scoreDuplicate(left, right)?.for).toContain(signal);
            expect(scoreDuplicate(right, left)?.for).toContain(signal);
            expect(duplicateNameIndex([left]).match(name)[0]?.id).toBe("a");
        }
    });
    it("lowers identical names for both confirmed speakers and different email domains", () => {
        const left = record("a", "Jana Šedivá", {
            primaryEmail: "jana@kestrel.example",
        });
        const right = record("b", "Jana Sediva", {
            primaryEmail: "jana@moravia.example",
        });
        const score = scoreDuplicate(left, right, true);
        expect(score).toMatchObject({
            confidence: "low",
            against: ["different_emails", "both_speakers"],
        });
        expect(score?.score).toBeLessThan(
            scoreDuplicate(left, right)?.score ?? 0,
        );
    });
    it("treats shared domains as weak corroboration and never as identity alone", () => {
        const left = record("a", "Ondra Kalous", {
            primaryEmail: "ondra@kestrel.example",
        });
        const right = record("b", "Ondřej Kalous", {
            emails: ["ondrej@kestrel.example"],
        });
        expect(scoreDuplicate(left, right)?.for).toContain("email_domain");
        expect(
            scoreDuplicate(left, { ...right, name: "Zim Teral" }),
        ).toBeNull();
    });
    it("does not pair unrelated surnames, unlike a given-name-only nickname lookup", () => {
        expect(
            scoreDuplicate(
                record("a", "Ondra Kalous"),
                record("b", "Ondřej Zimer"),
            ),
        ).toBeNull();
    });
    it.each([
        ["Release 2025", "Release 2026"],
        ["Q1 plan", "Q2 plan"],
        ["Release 2025 milestone", "Release 2026 milestones"],
    ])("does not suggest numbered things %s / %s via spelling similarity", (left, right) => {
        expect(
            scoreDuplicate(
                record("a", left, { kind: "entity" }),
                record("b", right, { kind: "entity" }),
            ),
        ).toBeNull();
    });
    it("still finds a typo in a thing when its digit sequences are equal", () => {
        expect(
            scoreDuplicate(
                record("a", "Release 2025 plan", { kind: "entity" }),
                record("b", "Release 2025 plam", { kind: "entity" }),
            )?.for,
        ).toContain("typo");
    });
    it("does not crowd out strong neighbours with shared given-name aliases", async () => {
        const source = record("source", "Zavi Duspektor");
        const strong = record("strong", "Zavi Duspektar");
        const unrelated = Array.from({ length: 60 }, (_, index) =>
            record(`a-${index}`, `Nelo ${index}`, {
                aliases: ["Zavi", "Zavi", "Zavi"],
            }),
        );
        const { candidates } = await rankDuplicateRecords(
            [source, ...unrelated, strong],
            source.id,
        );
        expect(
            candidates.some(
                (pair) =>
                    pair.left.id === strong.id || pair.right.id === strong.id,
            ),
        ).toBe(true);
    });
    it("prefers primary email, then more evidence, with a stable tie", () => {
        const a = record("a", "Ondra Kalous", { evidenceCount: 10 });
        const b = record("b", "Ondřej Kalous", {
            primaryEmail: "ondrej@kestrel.example",
        });
        expect(proposedSurvivor(a, b)).toBe("b");
        expect(proposedSurvivor(a, { ...b, primaryEmail: null })).toBe("a");
        expect(
            proposedSurvivor(
                { ...a, evidenceCount: 0 },
                { ...b, primaryEmail: null },
            ),
        ).toBe("a");
    });
});
