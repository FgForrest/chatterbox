/**
 * Czech stem variants of a word written without diacritics: every stem the
 * word could have had before its accents were dropped, so a name heard
 * inflected ("Šimákem", "Forestu", "Milane") meets the name as written
 * ("Šimák", "Forest", "Milan") whether either side kept its accents.
 *
 * Ported from evitaDB's `CzechVariantStemmer` (FG Forrest, a.s.; see
 * NOTICE): one walk over the ending tables of Lucene's `CzechStemmer`
 * (Dolamic & Savoy's light stemmer) read over the folded alphabet, forking
 * wherever an ending is ambiguous once the accents are gone. The set it
 * returns contains the folded stem Lucene's stemmer gives every accented
 * spelling of the word, and the word itself.
 *
 * The case-ending and possessive stages only shorten the word, and every
 * normalization rule rewrites at most its last two letters, so a variant is
 * the word's prefix of some length with its last two letters replaced.
 */

/** At most this many variants per word (3 case lengths × 2 × 3 + 1). */
const MAX_VARIANTS = 19;

/** Lengths the case endings leave: the vowel strip alone, and the table. */
function caseLengths(word: string): number[] {
    const lengths = new Set<number>();
    const len = word.length;
    lengths.add(withoutFinalVowel(word, len));
    tableOutcomes(word, len, lengths);
    return [...lengths];
}

/**
 * The full case-ending table, folded: an unguarded ending strips and ends
 * the walk; a guarded one (an ending only some accented spellings have)
 * records the stripped length and goes on as if it had not matched. No
 * family matches twice in one walk ("atech", "atum", "ata"/"aty", "at"
 * end incompatibly): the flag only makes that visible.
 */
function tableOutcomes(word: string, len: number, into: Set<number>): void {
    const ends = (suffix: string) => word.endsWith(suffix);
    let neuterAtUndecided = true;

    if (len > 7 && ends("atech")) {
        into.add(len - 5);
        neuterAtUndecided = false;
    }
    if (len > 6) {
        if (ends("etem")) {
            into.add(len - 4);
            return;
        }
        if (neuterAtUndecided && ends("atum")) {
            into.add(len - 4);
            neuterAtUndecided = false;
        }
    }
    if (len > 5) {
        if (
            [
                "ech",
                "ich",
                "eho",
                "emu",
                "ete",
                "eti",
                "iho",
                "imu",
                "ach",
                "ych",
                "ama",
                "ami",
                "ove",
                "ovi",
            ].some(ends)
        ) {
            into.add(len - 3);
            return;
        }
        if (["emi", "imi", "ymi"].some(ends)) {
            into.add(len - 3);
        }
        if (neuterAtUndecided && (ends("ata") || ends("aty"))) {
            into.add(len - 3);
            neuterAtUndecided = false;
        }
    }
    if (len > 4) {
        if (
            ["em", "es", "im", "um", "am", "os", "us", "ym", "mi", "ou"].some(
                ends,
            )
        ) {
            into.add(len - 2);
            return;
        }
        if (neuterAtUndecided && ends("at")) {
            into.add(len - 2);
        }
    }
    into.add(withoutFinalVowel(word, len));
}

/** The final-vowel strip, the case table's last tier. */
function withoutFinalVowel(word: string, len: number): number {
    return len > 3 && "aeiouy".includes(word[len - 1] ?? "") ? len - 1 : len;
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
 * Every outcome of the normalization rules on the stem of `length`: each
 * rule whose pattern matches (they return once applied), and none.
 */
function normalizeOutcomes(
    word: string,
    length: number,
    into: Set<string>,
): void {
    if (length === 0) {
        into.add("");
        return;
    }
    const stem = word.slice(0, length);
    const ends = (suffix: string) => stem.endsWith(suffix);
    // čt -> ck, št -> sk
    if (ends("ct")) into.add(rewrite(word, length, "c", "k"));
    else if (ends("st")) into.add(rewrite(word, length, "s", "k"));
    // [cč] -> k, [zž] -> h
    const last = stem[length - 1] ?? "";
    const penultimate = stem[length - 2] ?? "";
    if (last === "c") into.add(rewrite(word, length, penultimate, "k"));
    else if (last === "z") into.add(rewrite(word, length, penultimate, "h"));
    // e* -> * (the epenthetic e: "Hájek" -> "Hájk")
    if (length > 1 && penultimate === "e") {
        into.add(stem.slice(0, length - 2) + last);
    }
    // *ů* -> *o*
    if (length > 2 && penultimate === "u") {
        into.add(rewrite(word, length, "o", last));
    }
    into.add(stem);
}

/**
 * The Czech stem variants of a lowercase word without diacritics, the word
 * itself included.
 */
export function czechVariants(word: string): string[] {
    const stems = new Set<number>();
    for (const length of caseLengths(word)) {
        // Possessives: "-ov", "-in", "-uv" stripped or kept.
        if (
            length > 5 &&
            ["ov", "in", "uv"].some((suffix) =>
                word.slice(0, length).endsWith(suffix),
            )
        ) {
            stems.add(length - 2);
        }
        stems.add(length);
    }
    const variants = new Set<string>();
    for (const length of stems) normalizeOutcomes(word, length, variants);
    variants.add(word);
    if (variants.size > MAX_VARIANTS) {
        // The bound follows from the rules: a breach means the walk no
        // longer mirrors them.
        throw new Error(`More than ${MAX_VARIANTS} Czech stem variants`);
    }
    return [...variants];
}
