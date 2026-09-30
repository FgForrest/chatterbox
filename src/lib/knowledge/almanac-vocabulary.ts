/**
 * The vocabulary as the Almanac's editing needs it: the types a thing may
 * take, every type's label, and every relation, those a new fact may use
 * marked. Adopted private types are left out of what new records use, as
 * Learn does.
 */

import type { Vocabulary } from "@/lib/knowledge/vocabulary";

export interface AlmanacVocabulary {
    /** Types a thing may take; `shared` for the core's and the Organization's. */
    entityTypes: { key: string; label: string; shared: boolean }[];
    /** Every visible entity type's label, by key. */
    typeLabels: Record<string, string>;
    relations: {
        key: string;
        label: string;
        subjectTypes: string[];
        objectTypes: string[];
        objectKind: "entity" | "literal";
        cardinality: "one" | "many";
        /**
         * A private relation the Organization adopted: older facts still
         * use it, new ones use the Organization's.
         */
        adopted: boolean;
    }[];
}

export function almanacVocabulary(vocabulary: Vocabulary): AlmanacVocabulary {
    return {
        entityTypes: vocabulary.entityTypes
            .filter((type) => type.key !== "person" && !type.adoptedAsKey)
            .map((type) => ({
                key: type.key,
                label: type.label,
                shared: type.layer !== "private",
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        typeLabels: Object.fromEntries(
            vocabulary.entityTypes.map((type) => [type.key, type.label]),
        ),
        relations: vocabulary.relationTypes
            .map((relation) => ({
                key: relation.key,
                label: relation.label,
                subjectTypes: relation.subjectTypes,
                objectTypes: relation.objectTypes,
                objectKind: relation.objectKind,
                cardinality: relation.cardinality,
                adopted: relation.adoptedAsKey !== null,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    };
}
