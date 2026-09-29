/**
 * Suggested relation phrases that say much the same, grouped for the
 * curator (Phase 6): "pracuje na", "pracují na" and "pracoval na" are one
 * decision. Lexical: words compared on their first letters (Czech
 * inflects), two phrases alike when most of their words are. Pure. Grouping
 * by meaning (the embedding service) would find "vede" ~ "řídí" too; not
 * built yet.
 */

import { nameWords } from "@/lib/learn/name-match";

const STEM = 4;
const ALIKE = 0.5;

function stemsOf(phrase: string): Set<string> {
    return new Set(nameWords(phrase).map((word) => word.slice(0, STEM)));
}

function alike(a: Set<string>, b: Set<string>): boolean {
    if (a.size === 0 || b.size === 0) return false;
    let shared = 0;
    for (const stem of a) if (b.has(stem)) shared++;
    return shared / (a.size + b.size - shared) >= ALIKE;
}

/** The phrases' ids in groups of alike ones, each group in input order. */
export function groupPhrases(
    phrases: readonly { id: string; phrase: string }[],
): string[][] {
    const stems = phrases.map((phrase) => stemsOf(phrase.phrase));
    const parent = phrases.map((_, index) => index);
    const root = (index: number): number => {
        let at = index;
        while (parent[at] !== at) at = parent[at] as number;
        return at;
    };
    for (let i = 0; i < phrases.length; i++) {
        for (let j = i + 1; j < phrases.length; j++) {
            if (alike(stems[i] as Set<string>, stems[j] as Set<string>)) {
                parent[root(j)] = root(i);
            }
        }
    }
    const groups = new Map<number, string[]>();
    phrases.forEach((phrase, index) => {
        const group = groups.get(root(index)) ?? [];
        group.push(phrase.id);
        groups.set(root(index), group);
    });
    return [...groups.values()];
}
