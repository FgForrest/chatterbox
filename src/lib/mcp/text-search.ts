import { stemVariants } from "@/lib/knowledge/stemming";

/** Where a query word was found in a text: `[start, end)` offsets. */
export interface TextHit {
    start: number;
    end: number;
}

/** A query ready to match: per word, the forms it may take. */
export type PreparedQuery = readonly (readonly string[])[];

interface Token {
    start: number;
    end: number;
    forms: readonly string[];
}

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

function tokens(text: string, language: string | null): Token[] {
    const out: Token[] = [];
    for (const match of text.matchAll(WORD)) {
        const forms = stemVariants(match[0], language);
        if (forms.length === 0) continue;
        out.push({
            start: match.index,
            end: match.index + match[0].length,
            forms,
        });
    }
    return out;
}

/**
 * The query's words, each with its stems in `language` (any code
 * `stemmingLanguage` reads; null for none), case and accents folded.
 * Empty when the query has no words.
 */
export function prepareQuery(
    query: string,
    language: string | null,
): PreparedQuery {
    return tokens(query, language).map((token) => token.forms);
}

/**
 * Where `text` holds every word of `query` (prepared in the same
 * language), in text order; null when a word is missing or the query has
 * none. A word matches when one of its forms meets one of the query
 * word's.
 */
export function matchText(
    text: string,
    query: PreparedQuery,
    language: string | null,
): TextHit[] | null {
    if (query.length === 0) return null;
    const words = tokens(text, language);
    const hits: TextHit[] = [];
    for (const forms of query) {
        const wanted = new Set(forms);
        let found = false;
        for (const word of words) {
            if (word.forms.some((form) => wanted.has(form))) {
                hits.push({ start: word.start, end: word.end });
                found = true;
            }
        }
        if (!found) return null;
    }
    return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Up to `max` non-overlapping excerpts of `text` around `hits` (in text
 * order), `radius` characters either side, marked with "…" where cut.
 */
export function snippets(
    text: string,
    hits: readonly TextHit[],
    max = 3,
    radius = 100,
): string[] {
    const out: string[] = [];
    let coveredUntil = -1;
    for (const hit of hits) {
        if (out.length >= max) break;
        if (hit.start < coveredUntil) continue;
        const from = Math.max(0, hit.start - radius, coveredUntil);
        const to = Math.min(text.length, hit.end + radius);
        out.push(
            `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${
                to < text.length ? "…" : ""
            }`,
        );
        coveredUntil = to;
    }
    return out;
}
