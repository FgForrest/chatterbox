import { describe, expect, it } from "vitest";
import {
    CORE_ENTITY_TYPES,
    CORE_RELATIONS,
    DENIED_TOPICS,
    deniedTopicOf,
} from "@/lib/knowledge/vocabulary-core";

describe("the core vocabulary", () => {
    const entityKeys = new Set(CORE_ENTITY_TYPES.map((type) => type.key));

    it("has unique keys", () => {
        expect(entityKeys.size).toBe(CORE_ENTITY_TYPES.length);
        expect(new Set(CORE_RELATIONS.map((r) => r.key)).size).toBe(
            CORE_RELATIONS.length,
        );
    });

    it("relates only core entity types", () => {
        for (const relation of CORE_RELATIONS) {
            for (const key of [
                ...relation.subjectTypes,
                ...relation.objectTypes,
            ]) {
                expect(entityKeys.has(key), `${relation.key}: ${key}`).toBe(
                    true,
                );
            }
        }
    });

    it("gives literal relations no object types, and entity relations some", () => {
        for (const relation of CORE_RELATIONS) {
            expect(relation.objectTypes.length === 0, relation.key).toBe(
                relation.objectKind === "literal",
            );
            expect(relation.subjectTypes.length, relation.key).toBeGreaterThan(
                0,
            );
        }
    });

    it("has single-valued relations that can change over time", () => {
        expect(
            CORE_RELATIONS.filter((r) => r.cardinality === "one")
                .map((r) => r.key)
                .sort(),
        ).toEqual([
            "means",
            "part_of",
            "project_for",
            "reports_to",
            "works_for",
        ]);
    });
});

describe("denied topics", () => {
    it("names each topic's terms without diacritics, as they are compared", () => {
        for (const topic of DENIED_TOPICS) {
            for (const term of topic.terms) {
                expect(term).toBe(
                    term
                        .normalize("NFKD")
                        .replace(/\p{M}+/gu, "")
                        .toLowerCase(),
                );
            }
        }
    });

    it("refuses labels that name a denied topic, in any case or accent", () => {
        expect(deniedTopicOf("Health status")?.id).toBe("health");
        expect(deniedTopicOf("Diagnóza")?.id).toBe("health");
        expect(deniedTopicOf("je v manželství s")?.id).toBe("family");
        expect(deniedTopicOf("political views")?.id).toBe("demographics");
    });

    it("takes whole words only, so a work topic that contains one passes", () => {
        expect(deniedTopicOf("Healthcare project")).toBeNull();
        expect(deniedTopicOf("leads")).toBeNull();
        expect(deniedTopicOf("is the contact for")).toBeNull();
    });
});
