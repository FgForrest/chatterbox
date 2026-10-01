/**
 * Slovak stem variants of a word written without diacritics: every stem the
 * word could have had before its accents were dropped, so a name heard
 * inflected ("Novákom", "Bratislavou", "Horváthovej") meets the name as
 * written ("Novák", "Bratislava", "Horváthová") whether either side kept its
 * accents.
 *
 * Ported from evitaDB's `SlovakVariantStemmer` (FG Forrest, a.s.; see
 * NOTICE): one walk over the tables of evitaDB's own `SlovakStemmer` (an
 * in-house light stemmer, since neither Lucene nor Snowball has a Slovak
 * one, built on the architecture of Lucene's `CzechStemmer`) read over the
 * folded alphabet, forking wherever a rule is ambiguous once the accents are
 * gone: the "om" ending ("tričkom", but "chróm"), the genitive-plural "ie"
 * shortening ("stoličiek", but "bariér") and the epenthetic "e"/"o" before a
 * final "k" ("darček", but "hypoték"). The set it returns contains the folded
 * stem that `SlovakStemmer` gives every accented spelling of the word, and
 * the word itself, which evitaDB leaves out for Slovak and which is added
 * here as the Czech variants add it.
 *
 * The case-ending and possessive stages only shorten the word, and every
 * normalization rule (the "ie" shortening chained into the epenthesis
 * included) rewrites at most its last two letters, so a variant is the
 * word's prefix of some length with its last two letters replaced.
 */

/** At most this many variants per word (2 case lengths × 4 + the word). */
const MAX_VARIANTS = 9;

/**
 * Lengths the case endings leave, each through the possessive "-ov": an
 * unguarded ending strips and ends the walk; the guarded "om" records the
 * stripped length and goes on to the final-vowel strip, which leaves the
 * "m" alone.
 */
function stemLengths(word: string): Set<number> {
    const lengths = new Set<number>();
    for (const length of caseLengths(word)) {
        lengths.add(withoutPossessive(word, length));
    }
    return lengths;
}

/** The case-ending table, folded. */
function caseLengths(word: string): number[] {
    const len = word.length;
    const ends = (suffix: string) => word.endsWith(suffix);
    if (len > 6 && ["iach", "ovia"].some(ends)) {
        return [len - 4];
    }
    if (
        len > 5 &&
        [
            "ych",
            "ymi",
            "eho",
            "emu",
            "imi",
            "ach",
            "iam",
            "ami",
            "ovi",
            "och",
        ].some(ends)
    ) {
        return [len - 3];
    }
    const lengths: number[] = [];
    if (len > 4) {
        if (["am", "ov", "ou", "ej", "ia", "ie", "iu", "ym", "im"].some(ends)) {
            return [len - 2];
        }
        // "om" stripped, or kept: the final-vowel strip cannot fire on the "m".
        if (ends("om")) lengths.push(len - 2);
    }
    lengths.push(withoutFinalVowel(word, len));
    return lengths;
}

/** The final-vowel strip, the case table's last tier. */
function withoutFinalVowel(word: string, len: number): number {
    return len > 3 && isVowel(word[len - 1] ?? "") ? len - 1 : len;
}

/** The possessive "-ov" ("otcov"), always stripped. */
function withoutPossessive(word: string, length: number): number {
    return length > 5 && word.slice(0, length).endsWith("ov")
        ? length - 2
        : length;
}

/** A folded Slovak vowel. */
function isVowel(char: string): boolean {
    return char !== "" && "aeiouy".includes(char);
}

/** The stem of `length` with its last two letters replaced. */
function rewrite(
    word: string,
    length: number,
    penultimate: string,
    last: string,
): string {
    if (length === 0) return "";
    if (length === 1) return last;
    return word.slice(0, length - 2) + penultimate + last;
}

/**
 * Every outcome of the normalization rules on the stem of `length`. The
 * "i" trim and the "c" → "k" rewrite are unguarded (the rewrite ends the
 * rules); the "ie" shortening forks, and its applied branch chains into the
 * epenthesis check on the shortened tail while its skipped branch reaches
 * the same check on the original tail.
 */
function normalizeOutcomes(
    word: string,
    stemLength: number,
    into: Set<string>,
): void {
    if (stemLength === 0) {
        into.add("");
        return;
    }
    const at = (index: number) => word[index] ?? "";

    // i-final stems trimmed to the consonant ("kategóri-ám" = "ulic-iam")
    const l =
        stemLength > 3 && at(stemLength - 1) === "i"
            ? stemLength - 1
            : stemLength;

    // [cč] -> k, and no further rule
    if (at(l - 1) === "c") {
        into.add(rewrite(word, l, at(l - 2), "k"));
        return;
    }

    // ie -> e before a final consonant ("stoličiek" -> "stoliček"), chained
    // into the epenthesis when that consonant is k ("stoliček" -> "stoličk")
    if (
        l > 4 &&
        at(l - 3) === "i" &&
        at(l - 2) === "e" &&
        !isVowel(at(l - 1))
    ) {
        if (l - 1 > 4 && at(l - 1) === "k") {
            into.add(rewrite(word, l - 2, at(l - 4), "k"));
        }
        into.add(rewrite(word, l - 1, "e", at(l - 1)));
    }

    // the epenthetic o/e before a final k ("náramok" -> "náramk"), on the
    // unshortened tail
    if (
        l > 4 &&
        at(l - 1) === "k" &&
        (at(l - 2) === "o" || at(l - 2) === "e")
    ) {
        into.add(rewrite(word, l - 1, at(l - 3), "k"));
    }

    // every guarded rule off
    into.add(word.slice(0, l));
}

/**
 * The Slovak stem variants of a lowercase word without diacritics, the word
 * itself included.
 */
export function slovakVariants(word: string): string[] {
    const variants = new Set<string>();
    for (const length of stemLengths(word)) {
        normalizeOutcomes(word, length, variants);
    }
    variants.add(word);
    if (variants.size > MAX_VARIANTS) {
        // The bound follows from the rules: a breach means the walk no
        // longer mirrors them.
        throw new Error(`More than ${MAX_VARIANTS} Slovak stem variants`);
    }
    return [...variants];
}
