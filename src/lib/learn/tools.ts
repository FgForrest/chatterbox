/**
 * The tools a Learn run reads knowledge through (Task 3.1): the only way a
 * run reaches the knowledge base, whether the model calls them over MCP
 * (path 1) or the fallback calls them itself (path 2).
 *
 * Scoped by the run, never by arguments: the run's read context gives the
 * scopes (`readableScopes`: the owner's and the Organization's on a
 * private recording, the Organization's alone on a shared one), and an id
 * outside them is answered as nothing. Every call reads the scopes'
 * generations afresh (`knowledgeView`), so a change made while the run
 * works is seen, and spends one of the run's calls.
 *
 * Names are matched by their words (`findByName`); meaning (vectors) only
 * adds to what the words found for the same text, and only where an
 * embedding service answers.
 */

import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import {
    findByName,
    type KnowledgeView,
    knowledgeView,
    searchByMeaning,
} from "@/lib/knowledge/knowledge-loader";
import type { ReadContext } from "@/lib/knowledge/scope";
import { LearnToolBudgetExhausted } from "@/lib/learn/errors";

export { LearnToolBudgetExhausted } from "@/lib/learn/errors";

export interface LearnToolContext {
    read: Extract<ReadContext, { kind: "recording" }>;
    /** Calls left to the run; each tool call spends one. */
    budget: { remaining: number };
    /** The transcript's language: names are matched in their word forms. */
    language?: string | null;
}

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

const MAX_FOUND = 10;

async function viewFor(context: LearnToolContext): Promise<KnowledgeView> {
    if (context.budget.remaining <= 0) throw new LearnToolBudgetExhausted();
    context.budget.remaining--;
    return knowledgeView(context.read);
}

/**
 * The people and entities `text` may name, best first, with why. `type`
 * narrows to `person` or an entity type key.
 */
export async function findEntities(
    context: LearnToolContext,
    {
        text,
        type,
        byName = false,
    }: {
        text: string;
        type?: string;
        /** By its words alone, not by meaning. */
        byName?: boolean;
    },
): Promise<{ byMeaning: boolean; entities: FoundEntity[] }> {
    const view = await viewFor(context);
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
    for (const match of findByName(view, text, context.language ?? null)) {
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

/** One person or entity the run may read, or null. */
export async function getEntity(context: LearnToolContext, id: string) {
    const view = await viewFor(context);
    const item = view.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    return {
        id: item.id,
        kind: item.kind,
        typeKey: item.kind === "person" ? "person" : item.typeKey,
        name: item.name,
        description: item.description,
        scope: item.scope,
        otherNames: item.names.map((name) => ({
            text: name.text,
            kind: name.kind,
        })),
    };
}

type NamedSide =
    | { personId: string; name: string }
    | { entityId: string; name: string }
    | { literal: string };

/**
 * The current facts about a person or entity the run may read, each side
 * named; a fact whose other side the run may not read is left out.
 */
export async function findFacts(
    context: LearnToolContext,
    id: string,
): Promise<
    {
        subject: NamedSide;
        relationKey: string;
        object: NamedSide;
        scope: "personal" | "org";
    }[]
> {
    const view = await viewFor(context);
    const names = new Map(view.items.map((item) => [item.id, item.name]));
    if (!names.has(id)) return [];
    const idOf = (target: KnowledgeTarget) =>
        "personId" in target ? target.personId : target.entityId;
    const side = (target: KnowledgeTarget): NamedSide | null => {
        const name = names.get(idOf(target));
        if (name === undefined) return null;
        return "personId" in target
            ? { personId: target.personId, name }
            : { entityId: target.entityId, name };
    };
    return view.facts.flatMap((fact) => {
        const about =
            idOf(fact.subject) === id ||
            (!("literal" in fact.object) && idOf(fact.object) === id);
        if (!about) return [];
        const subject = side(fact.subject);
        const object =
            "literal" in fact.object
                ? { literal: fact.object.literal }
                : side(fact.object);
        if (!subject || !object) return [];
        return [
            {
                subject,
                relationKey: fact.relationKey,
                object,
                scope: fact.scope,
            },
        ];
    });
}
