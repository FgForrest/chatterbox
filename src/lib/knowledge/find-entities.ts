import {
    findByName,
    type KnowledgeView,
    searchByMeaning,
} from "@/lib/knowledge/knowledge-loader";

/** A person or entity a text may name, with why. */
export interface FoundEntity {
    id: string;
    kind: "person" | "entity";
    /** The entity's type; `person` for people. */
    typeKey: string;
    name: string;
    scope: "personal" | "org";
    /**
     * Why it matched: `exact`, `token`, `edit`, `trigram`, `stem` (by its
     * word forms), `part` (the name is part of the text), `meaning`.
     */
    reasons: string[];
    score: number;
}

/** What {@link findEntitiesInView} looks for. */
export interface FindEntitiesQuery {
    text: string;
    /** `person` or an entity type key. */
    type?: string;
    /** By its words alone, not by meaning. */
    byName?: boolean;
    /** The language the text was said in: inflected forms meet too. */
    language?: string | null;
}

const MAX_FOUND = 10;

/**
 * The people and entities of a view `text` may name, best first (ten at
 * most), with why: by their names, aliases and heard-as forms, and by
 * meaning where an embedding service answers. `byMeaning` says whether
 * meaning was searched.
 */
export async function findEntitiesInView(
    view: KnowledgeView,
    { text, type, byName = false, language = null }: FindEntitiesQuery,
): Promise<{ byMeaning: boolean; entities: FoundEntity[] }> {
    const items = new Map(view.items.map((item) => [item.id, item]));
    const found = new Map<string, FoundEntity>();
    const add = (id: string, reason: string, score: number) => {
        const item = items.get(id);
        if (!item) return;
        const typeKey = item.kind === "person" ? "person" : item.typeKey;
        if (type && type !== typeKey) return;
        const held = found.get(id);
        if (held) {
            if (!held.reasons.includes(reason)) held.reasons.push(reason);
            held.score = Math.max(held.score, score);
            return;
        }
        found.set(id, {
            id,
            kind: item.kind,
            typeKey,
            name: item.name,
            scope: item.scope,
            reasons: [reason],
            score,
        });
    };
    for (const match of findByName(view, text, language)) {
        add(match.id, match.reason, match.score);
    }
    const meaning = byName
        ? { available: false, hits: [] }
        : await searchByMeaning(view, text, MAX_FOUND);
    for (const hit of meaning.hits) {
        if (hit.kind === "entity") add(hit.id, "meaning", hit.score);
    }
    return {
        byMeaning: meaning.available,
        entities: [...found.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_FOUND),
    };
}
