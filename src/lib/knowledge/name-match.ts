/**
 * Matching a name as it was spoken or written against the names, aliases
 * and heard-as forms a scope knows. Pure; a caller that knows the language
 * passes its stemmer (`WordStemmer`), so a name heard inflected meets the
 * name as written ("Šimákem", "Šimák"). Nicknames and addressing stay
 * the model's to judge: this only finds candidates, each with the reason
 * it matched.
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

export type MatchReason =
    | "exact"
    | "token"
    | "edit"
    | "trigram"
    /** Every word of the query meets a word of the name by its stems. */
    | "stem"
    /** Every word of the name is in the query: "MCP" in "MCP server". */
    | "part";

/**
 * The stems a word may have in one language, the word itself among them,
 * each written as `normalizeName` writes a word. Called for every word a
 * query is compared with: keep the stems it works out (`stemVariants`).
 */
export interface WordStemmer {
    key: string;
    stem(word: string): readonly string[];
}

/** The words of a name as written, accents and all. */
function wordsOf(name: string): string[] {
    return name
        .normalize("NFC")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/** Below this length, a stem must be met exactly, not one letter off. */
const NEAR_STEM_LENGTH = 5;

/**
 * Whether two words meet by their stems: one stem in common, or (`near`)
 * two long stems an edit apart ("shopt" and "shoptt", a light stemmer's
 * slip on "Shoptetem").
 */
function stemsMeet(
    mine: readonly string[],
    theirs: readonly string[],
): "same" | "near" | null {
    for (const stem of mine) if (theirs.includes(stem)) return "same";
    for (const a of mine) {
        if (a.length < NEAR_STEM_LENGTH) continue;
        for (const b of theirs) {
            if (
                b.length >= NEAR_STEM_LENGTH &&
                a[0] === b[0] &&
                boundedLevenshtein(a, b, 1) <= 1
            ) {
                return "near";
            }
        }
    }
    return null;
}

/**
 * How the words of a query and of a name meet by their stems: all the
 * query's (`stem`), or all the name's (`part`), with how well.
 */
function scoreStems(
    query: readonly (readonly string[])[],
    name: readonly (readonly string[])[],
    /** Words as they are (no language): only a name inside the query. */
    plain: boolean,
): { score: number; reason: MatchReason } | null {
    const covers = (
        from: readonly (readonly string[])[],
        into: readonly (readonly string[])[],
    ): "same" | "near" | null => {
        let near = false;
        for (const word of from) {
            let best: "same" | "near" | null = null;
            for (const other of into) {
                const met = plain
                    ? word.some((stem) => other.includes(stem))
                        ? "same"
                        : null
                    : stemsMeet(word, other);
                if (met === "same") {
                    best = "same";
                    break;
                }
                best = best ?? met;
            }
            if (!best) return null;
            near ||= best === "near";
        }
        return from.length > 0 ? (near ? "near" : "same") : null;
    };
    const whole = plain ? null : covers(query, name);
    if (whole) {
        return { score: whole === "same" ? 0.88 : 0.8, reason: "stem" };
    }
    const part = covers(name, query);
    if (part) {
        return { score: part === "same" ? 0.7 : 0.65, reason: "part" };
    }
    return null;
}

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

interface IndexedName {
    id: string;
    name: string;
    normalized: string;
    words: number;
    grams: number;
}

function scoreEntry(
    query: string,
    queryWords: number,
    queryGrams: number,
    entry: IndexedName,
    sharedWords: number,
    sharedGrams: number,
): { score: number; reason: MatchReason } | null {
    if (query === entry.normalized) return { score: 1, reason: "exact" };
    if (sharedWords === queryWords) return { score: 0.9, reason: "token" };
    const allowed = Math.max(
        1,
        Math.floor(Math.min(query.length, entry.normalized.length) / 5),
    );
    // An edit changes at most three trigrams: fewer shared, and the names
    // are further apart than that.
    if (sharedGrams >= queryGrams - 3 * allowed) {
        const distance = boundedLevenshtein(query, entry.normalized, allowed);
        if (distance <= allowed) {
            return { score: 0.85 - distance * 0.05, reason: "edit" };
        }
    }
    const similarity =
        sharedGrams / (queryGrams + entry.grams - sharedGrams || 1);
    if (similarity >= TRIGRAM_FLOOR) {
        return { score: similarity * 0.8, reason: "trigram" };
    }
    return null;
}

function compact(postings: Map<string, number[]>): Map<string, Int32Array> {
    return new Map(
        [...postings].map(([key, list]) => [key, Int32Array.from(list)]),
    );
}

/**
 * Names normalized once, with their words and trigrams posted, so a query
 * scores only the names that share a word or a trigram with it. Built when
 * a scope is loaded into memory; `bytes` is its own estimate of its size.
 */
export class NameIndex {
    private readonly entries: IndexedName[] = [];
    private readonly byWord: Map<string, Int32Array>;
    private readonly byGram: Map<string, Int32Array>;
    readonly bytes: number;

    constructor(candidates: readonly NameCandidate[]) {
        const words = new Map<string, number[]>();
        const grams = new Map<string, number[]>();
        let postings = 0;
        let text = 0;
        for (const candidate of candidates) {
            for (const name of candidate.names) {
                const normalized = normalizeName(name);
                if (!normalized) continue;
                const index = this.entries.length;
                const wordSet = new Set(normalized.split(" "));
                const gramSet = trigrams(normalized);
                this.entries.push({
                    id: candidate.id,
                    name,
                    normalized,
                    words: wordSet.size,
                    grams: gramSet.size,
                });
                for (const word of wordSet) post(words, word, index);
                for (const gram of gramSet) post(grams, gram, index);
                postings += wordSet.size + gramSet.size;
                text += normalized.length;
            }
        }
        this.byWord = compact(words);
        this.byGram = compact(grams);
        this.bytes =
            this.entries.length * 160 +
            text * 2 +
            postings * 4 +
            (words.size + grams.size) * 128;
    }

    /** How many names it holds. */
    get size(): number {
        return this.entries.length;
    }

    /**
     * The candidates matching `query`, best first; see `matchNames`. With
     * a `stemmer`, words also meet by their stems in its language.
     */
    match(query: string, stemmer: WordStemmer = PLAIN): NameMatch[] {
        const normalized = normalizeName(query);
        if (!normalized) return [];
        const queryStems = wordsOf(query).map((word) => stemmer.stem(word));
        const queryWords = new Set(normalized.split(" "));
        const queryGrams = trigrams(normalized);
        const sharedGrams = new Map<number, number>();
        for (const gram of queryGrams) {
            for (const index of this.byGram.get(gram) ?? []) {
                sharedGrams.set(index, (sharedGrams.get(index) ?? 0) + 1);
            }
        }
        const sharedWords = new Map<number, number>();
        for (const word of queryWords) {
            for (const index of this.byWord.get(word) ?? []) {
                sharedWords.set(index, (sharedWords.get(index) ?? 0) + 1);
            }
        }
        const best = new Map<string, NameMatch>();
        const considered = new Set([
            ...sharedGrams.keys(),
            ...sharedWords.keys(),
        ]);
        for (const index of considered) {
            const entry = this.entries[index];
            if (!entry) continue;
            let found = scoreEntry(
                normalized,
                queryWords.size,
                queryGrams.size,
                entry,
                sharedWords.get(index) ?? 0,
                sharedGrams.get(index) ?? 0,
            );
            if (!found || found.score < 0.88) {
                const stems = scoreStems(
                    queryStems,
                    wordsOf(entry.name).map((word) => stemmer.stem(word)),
                    stemmer === PLAIN,
                );
                if (stems && (!found || stems.score > found.score)) {
                    found = stems;
                }
            }
            const held = best.get(entry.id);
            if (found && (!held || found.score > held.score)) {
                best.set(entry.id, {
                    id: entry.id,
                    name: entry.name,
                    ...found,
                });
            }
        }
        return [...best.values()].sort((a, b) => b.score - a.score);
    }
}

/** Words as they are, for a query whose language has no stemmer. */
const PLAIN: WordStemmer = {
    key: "",
    stem: (word) => {
        const folded = normalizeName(word);
        return folded ? [folded] : [];
    },
};

function post(postings: Map<string, number[]>, key: string, index: number) {
    const list = postings.get(key);
    if (list) list.push(index);
    else postings.set(key, [index]);
}

/**
 * The candidates whose names match `query`, best first, each once with its
 * best-matching name and why it matched: the same normalized name, all of
 * the query's words, a few edits apart, or close by trigrams. A name
 * sharing neither a word nor a trigram with the query is not considered.
 */
export function matchNames(
    query: string,
    candidates: readonly NameCandidate[],
    stemmer?: WordStemmer,
): NameMatch[] {
    return new NameIndex(candidates).match(query, stemmer);
}
