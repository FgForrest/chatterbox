/**
 * The stems a name's word may have in the language it was said in, so a
 * name heard inflected meets the name as written: "Šimákem" and
 * "Šimák", "Helsingissä" and "Helsinki"'s "helsing".
 *
 * Czech, Slovak, Polish and Romanian are written with accents that are
 * often left out (by people, and by transcription): their stemmers read a
 * word without accents and return every stem it could have had (ported
 * from evitaDB). Other languages Snowball knows stem the word as written,
 * then drop its accents. English is left alone: its names take no case
 * endings, and stemming would make Hughes Hugh and Williams William. Every
 * result is a word as `normalizeName` writes it, the word itself among
 * them; a language with no stemmer gives the word alone.
 */

// Named, not default: bundled, the package has no default export.
import { newStemmer } from "snowball-stemmers";
import { normalizeName } from "@/lib/knowledge/name-match";
import { czechVariants } from "@/lib/knowledge/stemming/czech";
import { polishVariants } from "@/lib/knowledge/stemming/polish";
import { romanianVariants } from "@/lib/knowledge/stemming/romanian";
import { slovakVariants } from "@/lib/knowledge/stemming/slovak";

/** Stemmers that read a word without accents, by language. */
const VARIANTS: Record<string, (word: string) => string[]> = {
    cs: czechVariants,
    sk: slovakVariants,
    pl: polishVariants,
    ro: romanianVariants,
};

/** Snowball's algorithm for a language, by its ISO 639-1 code. */
const SNOWBALL: Record<string, string> = {
    ar: "arabic",
    ca: "catalan",
    da: "danish",
    de: "german",
    es: "spanish",
    eu: "basque",
    fi: "finnish",
    fr: "french",
    ga: "irish",
    hu: "hungarian",
    hy: "armenian",
    it: "italian",
    nl: "dutch",
    no: "norwegian",
    pt: "portuguese",
    ru: "russian",
    sl: "slovene",
    sv: "swedish",
    ta: "tamil",
    tr: "turkish",
};

/**
 * ISO 639-2 and -3 codes and English names transcription may give instead
 * of the two-letter code ("ces", "czech").
 */
const ALIASES: Record<string, string> = {
    ces: "cs",
    cze: "cs",
    czech: "cs",
    slk: "sk",
    slo: "sk",
    slovak: "sk",
    pol: "pl",
    polish: "pl",
    ron: "ro",
    rum: "ro",
    romanian: "ro",
    moldavian: "ro",
    ara: "ar",
    arabic: "ar",
    cat: "ca",
    catalan: "ca",
    dan: "da",
    danish: "da",
    deu: "de",
    ger: "de",
    german: "de",
    spa: "es",
    spanish: "es",
    eus: "eu",
    baq: "eu",
    basque: "eu",
    fin: "fi",
    finnish: "fi",
    fra: "fr",
    fre: "fr",
    french: "fr",
    gle: "ga",
    irish: "ga",
    hun: "hu",
    hungarian: "hu",
    hye: "hy",
    arm: "hy",
    armenian: "hy",
    ita: "it",
    italian: "it",
    nld: "nl",
    dut: "nl",
    dutch: "nl",
    nor: "no",
    nob: "no",
    nb: "no",
    nno: "no",
    nn: "no",
    norwegian: "no",
    por: "pt",
    portuguese: "pt",
    rus: "ru",
    russian: "ru",
    slv: "sl",
    slovene: "sl",
    slovenian: "sl",
    swe: "sv",
    swedish: "sv",
    tam: "ta",
    tamil: "ta",
    tur: "tr",
    turkish: "tr",
};

/**
 * The language a code names, as this module keys it ("cs-CZ", "ces" and
 * "Czech" are all "cs"), or null when it has no stemmer.
 */
export function stemmingLanguage(
    code: string | null | undefined,
): string | null {
    if (!code) return null;
    const lower = code.trim().toLowerCase();
    const base = lower.split(/[-_]/)[0] ?? "";
    for (const key of [lower, base]) {
        const language = ALIASES[key] ?? key;
        if (language in VARIANTS || language in SNOWBALL) return language;
    }
    return null;
}

const stemmers = new Map<string, { stem(word: string): string }>();

/** Snowball's stem of a word, or the word when the stemmer fails. */
function snowballStem(language: string, word: string): string {
    try {
        let stemmer = stemmers.get(language);
        if (!stemmer) {
            stemmer = newStemmer(SNOWBALL[language] ?? "");
            stemmers.set(language, stemmer);
        }
        return stemmer.stem(word);
    } catch {
        return word;
    }
}

/**
 * Stems already worked out, by language and word: names repeat (first
 * names, surnames), and every lookup stems the names it is compared with.
 * Bounded: past the limit, the oldest half goes.
 */
const MEMO_LIMIT = 50_000;
const memo = new Map<string, readonly string[]>();

/**
 * The stems one word (as written, any case) may have in `language` (a code
 * `stemmingLanguage` reads), the word itself among them, each as
 * `normalizeName` writes a word. Empty for a word with no letters.
 */
export function stemVariants(
    word: string,
    language: string | null,
): readonly string[] {
    const key = stemmingLanguage(language);
    const id = `${key ?? ""}\u0000${word}`;
    const held = memo.get(id);
    if (held) return held;
    const stems = stemsOf(word, key);
    if (memo.size >= MEMO_LIMIT) {
        let drop = MEMO_LIMIT / 2;
        for (const old of memo.keys()) {
            memo.delete(old);
            if (--drop === 0) break;
        }
    }
    memo.set(id, stems);
    return stems;
}

function stemsOf(word: string, key: string | null): readonly string[] {
    const folded = normalizeName(word);
    if (!folded || folded.includes(" ")) return folded ? [folded] : [];
    const variants = key ? VARIANTS[key] : undefined;
    if (variants) return variants(folded);
    if (key && key in SNOWBALL) {
        const stem = normalizeName(snowballStem(key, word.toLowerCase()));
        return stem && stem !== folded ? [folded, stem] : [folded];
    }
    return [folded];
}
