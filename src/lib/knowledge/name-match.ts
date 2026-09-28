/**
 * Matching a name as it was spoken or written against the names, aliases
 * and heard-as forms a scope knows. Pure and the same for every language:
 * word forms, nicknames and addressing are the model's to judge, so this
 * only finds candidates, each with the reason it matched.
 */

/** Latin letters that NFKD leaves whole. */
const LATIN_FOLDS: Record<string, string> = {
    ł: "l",
    đ: "d",
    ð: "d",
    ø: "o",
    æ: "ae",
    œ: "oe",
    ß: "ss",
    þ: "th",
    ı: "i",
    ħ: "h",
};

/** Cyrillic and Greek, to Latin letters, lowercase and without marks. */
const TRANSLITERATION: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    ґ: "g",
    д: "d",
    е: "e",
    ё: "e",
    є: "ye",
    ж: "zh",
    з: "z",
    и: "i",
    і: "i",
    ї: "yi",
    й: "i",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "kh",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "shch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
    α: "a",
    β: "v",
    γ: "g",
    δ: "d",
    ε: "e",
    ζ: "z",
    η: "i",
    θ: "th",
    ι: "i",
    κ: "k",
    λ: "l",
    μ: "m",
    ν: "n",
    ξ: "x",
    ο: "o",
    π: "p",
    ρ: "r",
    σ: "s",
    ς: "s",
    τ: "t",
    υ: "y",
    φ: "f",
    χ: "ch",
    ψ: "ps",
    ω: "o",
};

/**
 * A name as it is compared: decomposed, marks stripped, lowercase, the
 * letters decomposition leaves whole folded, Cyrillic and Greek written in
 * Latin letters, and the words joined by single spaces.
 */
export function normalizeName(name: string): string {
    const plain = name
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        // Greek writes "ou" as one sound in two letters.
        .replaceAll("ου", "ou");
    let latin = "";
    for (const char of plain) {
        latin += LATIN_FOLDS[char] ?? TRANSLITERATION[char] ?? char;
    }
    return latin
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .join(" ");
}

function trigrams(value: string): Set<string> {
    const grams = new Set<string>();
    for (const word of value.split(" ").filter(Boolean)) {
        const padded = `  ${word} `;
        for (let i = 0; i + 3 <= padded.length; i++) {
            grams.add(padded.slice(i, i + 3));
        }
    }
    return grams;
}

/**
 * How alike two normalized names are by their three-letter pieces, from 0
 * to 1 (the Jaccard index): word forms of one name stay close.
 */
export function trigramSimilarity(a: string, b: string): number {
    const left = trigrams(a);
    const right = trigrams(b);
    if (left.size === 0 || right.size === 0) return 0;
    let shared = 0;
    for (const gram of left) if (right.has(gram)) shared++;
    return shared / (left.size + right.size - shared);
}

/**
 * The edit distance between two strings, counted up to `max`; past it,
 * `max + 1`. Stops as soon as the bound is exceeded.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const value = Math.min(
                (previous[j] ?? 0) + 1,
                (current[j - 1] ?? 0) + 1,
                (previous[j - 1] ?? 0) + cost,
            );
            current.push(value);
            best = Math.min(best, value);
        }
        if (best > max) return max + 1;
        previous = current;
    }
    const distance = previous[b.length] ?? max + 1;
    return distance > max ? max + 1 : distance;
}

export type MatchReason = "exact" | "token" | "edit" | "trigram";

export interface NameMatch {
    id: string;
    /** The candidate's name that matched, as given. */
    name: string;
    score: number;
    reason: MatchReason;
}

export interface NameCandidate {
    id: string;
    /** Its name, aliases and heard-as forms. */
    names: readonly string[];
}

/** Below this trigram similarity, two names are not offered as one. */
const TRIGRAM_FLOOR = 0.4;

function score(
    query: string,
    name: string,
): { score: number; reason: MatchReason } | null {
    if (!query || !name) return null;
    if (query === name) return { score: 1, reason: "exact" };
    const queryWords = query.split(" ");
    const nameWords = new Set(name.split(" "));
    if (queryWords.every((word) => nameWords.has(word))) {
        return { score: 0.9, reason: "token" };
    }
    const allowed = Math.max(
        1,
        Math.floor(Math.min(query.length, name.length) / 5),
    );
    const distance = boundedLevenshtein(query, name, allowed);
    if (distance <= allowed) {
        return { score: 0.85 - distance * 0.05, reason: "edit" };
    }
    const similarity = trigramSimilarity(query, name);
    if (similarity >= TRIGRAM_FLOOR) {
        return { score: similarity * 0.8, reason: "trigram" };
    }
    return null;
}

/**
 * The candidates whose names match `query`, best first, each once with its
 * best-matching name and why it matched: the same normalized name, all of
 * the query's words, a few edits apart, or close by trigrams.
 */
export function matchNames(
    query: string,
    candidates: readonly NameCandidate[],
): NameMatch[] {
    const normalized = normalizeName(query);
    const matches: NameMatch[] = [];
    for (const candidate of candidates) {
        let best: NameMatch | null = null;
        for (const name of candidate.names) {
            const found = score(normalized, normalizeName(name));
            if (found && (!best || found.score > best.score)) {
                best = { id: candidate.id, name, ...found };
            }
        }
        if (best) matches.push(best);
    }
    return matches.sort((a, b) => b.score - a.score);
}
