/**
 * Polish stem variants of a word written without diacritics: every stem the
 * word could have had before its accents were dropped, so a name heard
 * inflected ("Krakowem", "Łodzi", "Kowalskiego") meets the name as written
 * ("Kraków", "Łódź", "Kowalski") whether either side kept its accents.
 *
 * Ported from evitaDB's `PolishVariantStemmer` (FG Forrest, a.s.; see
 * NOTICE): the Snowball Polish stemmer, as Lucene vendors it, read over the
 * folded alphabet (ł folded to l, as `normalizeName` does). Its forks do not
 * guard branches of a fixed walk, they decide which entries exist in the
 * ending table, which is scanned longest suffix first, first match wins. So
 * every entry any reading can hold sits in one merged table, tagged with the
 * forks it needs on and off, and the scan walks cells of that configuration
 * space: where a matching entry is possible for only part of a cell, that
 * part fires it and the rest scans on past it. The set it returns contains
 * the folded stem Snowball gives every accented spelling of the word, and
 * the word itself.
 *
 * Every action truncates the word or rewrites the last letter it leaves, so
 * a variant is the word's prefix of some length with its last letter
 * perhaps replaced.
 */

/**
 * The fold-ambiguity forks: families of table entries that exist or not
 * depending on how the word was spelled before folding.
 */
const L_ENDINGS = 1;
const NASAL_ENDINGS = 2;
const SOFT_ENDINGS = 4;
const OW_ENDING = 8;
const NASAL_HOMOGRAPHS = 16;
const SZ_NASAL_ACTIONS = 32;
const CIE_HOMOGRAPH = 64;

/** At most this many variants per word. */
const MAX_VARIANTS = 24;
/** At most this many cells waiting to be scanned. */
const MAX_STATES = 32;

/**
 * One entry of the merged table: the folded suffix, its action (1 delete,
 * 2 → `s`, 3 delete in R1 else → `s`, 4 → `l`, 5 delete then the second
 * table), whether the suffix must start inside R1, and the forks that must
 * be on and off for the entry to exist.
 */
type Entry = {
    suffix: string;
    action: number;
    r1Required: boolean;
    needOn: number;
    needOff: number;
};

function entry(
    suffix: string,
    action: number,
    r1Required: boolean,
    needOn: number,
    needOff: number,
): Entry {
    return { suffix, action, r1Required, needOn, needOff };
}

/**
 * The merged main table, longest suffix first. Same-suffix entries (`sza`,
 * `sze`, `e`, `ac`) carry disjoint conditions.
 */
const MAIN: Entry[] = [
    // plain-spelled entries, present in every reading
    entry("a", 1, true, 0, 0),
    entry("ia", 1, true, 0, 0),
    entry("iejsza", 1, false, 0, 0),
    entry("icie", 1, false, 0, 0),
    entry("ajcie", 1, false, 0, 0),
    entry("iejsze", 1, false, 0, 0),
    entry("ach", 1, true, 0, 0),
    entry("iach", 1, true, 0, 0),
    entry("ich", 5, false, 0, 0),
    entry("ych", 5, false, 0, 0),
    entry("i", 1, true, 0, 0),
    entry("ali", 1, false, 0, 0),
    entry("ieli", 1, false, 0, 0),
    entry("ili", 1, false, 0, 0),
    entry("ami", 1, true, 0, 0),
    entry("iami", 1, true, 0, 0),
    entry("imi", 5, false, 0, 0),
    entry("ymi", 5, false, 0, 0),
    entry("owi", 1, true, 0, 0),
    entry("iowi", 1, true, 0, 0),
    entry("aj", 1, false, 0, 0),
    entry("ej", 5, false, 0, 0),
    entry("iej", 5, false, 0, 0),
    entry("am", 1, false, 0, 0),
    entry("em", 1, true, 0, 0),
    entry("iem", 1, true, 0, 0),
    entry("im", 5, false, 0, 0),
    entry("om", 1, true, 0, 0),
    entry("iom", 1, true, 0, 0),
    entry("ym", 5, false, 0, 0),
    entry("o", 1, true, 0, 0),
    entry("ego", 5, false, 0, 0),
    entry("iego", 5, false, 0, 0),
    entry("u", 1, true, 0, 0),
    entry("iu", 1, true, 0, 0),
    entry("y", 5, false, 0, 0),
    entry("amy", 1, false, 0, 0),
    entry("emy", 1, false, 0, 0),
    entry("imy", 1, false, 0, 0),
    entry("asz", 1, false, 0, 0),
    entry("esz", 1, false, 0, 0),
    entry("isz", 1, false, 0, 0),
    entry("emu", 5, false, 0, 0),
    entry("iemu", 5, false, 0, 0),
    // the three readings of sza/sze
    entry("sza", 3, false, SZ_NASAL_ACTIONS, 0),
    entry("sza", 1, false, 0, SZ_NASAL_ACTIONS | NASAL_HOMOGRAPHS),
    entry("sze", 2, false, SZ_NASAL_ACTIONS, 0),
    entry("sze", 1, false, 0, SZ_NASAL_ACTIONS | NASAL_HOMOGRAPHS),
    // e is R1-gated as plain e, unconditional as folded ę
    entry("e", 1, true, 0, NASAL_ENDINGS),
    entry("e", 1, false, NASAL_ENDINGS, 0),
    // the nasal homographs, the plain endings only with the fork off
    entry("ie", 1, true, 0, NASAL_HOMOGRAPHS),
    entry("acie", 1, false, 0, NASAL_HOMOGRAPHS),
    entry("ecie", 1, false, 0, NASAL_HOMOGRAPHS),
    entry("cie", 1, false, 0, CIE_HOMOGRAPH),
    // the ł-spelled past tense
    entry("ala", 1, false, L_ENDINGS, 0),
    entry("iala", 1, false, L_ENDINGS, 0),
    entry("ila", 1, false, L_ENDINGS, 0),
    entry("alam", 1, false, L_ENDINGS, 0),
    entry("ialam", 1, false, L_ENDINGS, 0),
    entry("ilam", 1, false, L_ENDINGS, 0),
    entry("alem", 1, false, L_ENDINGS, 0),
    entry("ialem", 1, false, L_ENDINGS, 0),
    entry("ilem", 1, false, L_ENDINGS, 0),
    entry("alo", 1, false, L_ENDINGS, 0),
    entry("ialo", 1, false, L_ENDINGS, 0),
    entry("ilo", 1, false, L_ENDINGS, 0),
    entry("aly", 1, false, L_ENDINGS, 0),
    entry("ialy", 1, false, L_ENDINGS, 0),
    entry("ily", 1, false, L_ENDINGS, 0),
    entry("al", 1, false, L_ENDINGS, 0),
    entry("ial", 1, false, L_ENDINGS, 0),
    entry("il", 1, false, L_ENDINGS, 0),
    entry("las", 4, false, L_ENDINGS, 0),
    entry("alas", 1, false, L_ENDINGS, 0),
    entry("ialas", 1, false, L_ENDINGS, 0),
    entry("ilas", 1, false, L_ENDINGS, 0),
    entry("les", 4, false, L_ENDINGS, 0),
    entry("ales", 1, false, L_ENDINGS, NASAL_HOMOGRAPHS),
    entry("iales", 1, false, L_ENDINGS, 0),
    entry("iles", 1, false, L_ENDINGS, 0),
    entry("lyscie", 4, false, L_ENDINGS, 0),
    entry("alyscie", 1, false, L_ENDINGS, 0),
    entry("ialyscie", 1, false, L_ENDINGS, 0),
    entry("ilyscie", 1, false, L_ENDINGS, 0),
    entry("lysmy", 4, false, L_ENDINGS, 0),
    entry("alysmy", 1, false, L_ENDINGS, 0),
    entry("ialysmy", 1, false, L_ENDINGS, 0),
    entry("ilysmy", 1, false, L_ENDINGS, 0),
    // the ą/ę-spelled endings
    entry("aca", 1, false, NASAL_ENDINGS, 0),
    entry("ajaca", 1, false, NASAL_ENDINGS, 0),
    entry("szaca", 2, false, NASAL_ENDINGS, 0),
    entry("ajac", 1, false, NASAL_ENDINGS, 0),
    entry("ace", 1, false, NASAL_ENDINGS, 0),
    entry("ajace", 1, false, NASAL_ENDINGS, 0),
    entry("szace", 2, false, NASAL_ENDINGS, 0),
    entry("aja", 1, false, NASAL_ENDINGS, 0),
    // ac exists with nasal or soft endings on: two disjoint cells
    entry("ac", 1, false, NASAL_ENDINGS, 0),
    entry("ac", 1, false, SOFT_ENDINGS, NASAL_ENDINGS),
    // the ś/ć-spelled endings
    entry("iec", 1, false, SOFT_ENDINGS, 0),
    entry("ic", 1, false, SOFT_ENDINGS, 0),
    entry("asc", 1, false, SOFT_ENDINGS, 0),
    entry("esc", 1, false, SOFT_ENDINGS, 0),
    entry("liscie", 4, false, SOFT_ENDINGS, 0),
    entry("aliscie", 1, false, SOFT_ENDINGS, 0),
    entry("ieliscie", 1, false, SOFT_ENDINGS, 0),
    entry("iliscie", 1, false, SOFT_ENDINGS, 0),
    entry("lismy", 4, false, SOFT_ENDINGS, 0),
    entry("alismy", 1, false, SOFT_ENDINGS, 0),
    entry("ielismy", 1, false, SOFT_ENDINGS, 0),
    entry("ilismy", 1, false, SOFT_ENDINGS, 0),
    // the genitive plural ów
    entry("ow", 1, true, OW_ENDING, 0),
    // stable: equal lengths keep the order above
].sort((a, b) => b.suffix.length - a.suffix.length);

/** The second table (Snowball's `a_1`), tried after an action-5 delete. */
const SECOND: Entry[] = [
    entry("iejsz", 1, false, 0, 0),
    entry("ajac", 1, false, NASAL_ENDINGS, 0),
    entry("szac", 2, false, NASAL_ENDINGS, 0),
    entry("ac", 1, false, NASAL_ENDINGS, 0),
    entry("sz", 1, false, 0, 0),
];

/** The `by` particles, the same in every reading. */
const BY_PARTICLES = ["byscie", "bysmy", "bym", "bys", "by"];

const isVowel = (char: string | undefined) =>
    char !== undefined && "aeiouy".includes(char);

/** Where R1 starts: Snowball's `mark_regions`, over the folded alphabet. */
function markR1(word: string): number {
    const len = word.length;
    let i = 0;
    while (i < len && !isVowel(word[i])) i++;
    if (i >= len) return len;
    i++;
    while (i < len && isVowel(word[i])) i++;
    if (i >= len) return len;
    return i + 1;
}

/** The word's length once a `by` particle wholly inside R1 is stripped. */
function withoutByParticle(word: string, p1: number): number {
    const len = word.length;
    for (const particle of BY_PARTICLES) {
        const pos = len - particle.length;
        if (pos >= p1 && word.endsWith(particle)) return pos;
    }
    return len;
}

/** Does the entry exist in some reading of the cell? */
const exists = (entry: Entry, on: number, off: number) =>
    (entry.needOn & off) === 0 && (entry.needOff & on) === 0;

/** Does the stem of `len` end in the entry's suffix, two letters in? */
function suffixAt(word: string, len: number, entry: Entry): number {
    const pos = len - entry.suffix.length;
    return pos >= 2 && word.startsWith(entry.suffix, pos) ? pos : -1;
}

/**
 * The Polish stem variants of a lowercase word without diacritics, the word
 * itself included.
 */
export function polishVariants(word: string): string[] {
    const variants = new Set<string>();
    /** The prefix of `length`, its last letter replaced by `last` if given. */
    const add = (length: number, last?: string) => {
        variants.add(
            last === undefined
                ? word.slice(0, length)
                : word.slice(0, length - 1) + last,
        );
    };

    if (word.length >= 2) {
        const p1 = markR1(word);
        // the by particles fork nothing: the same for every reading
        const len = withoutByParticle(word, p1);

        /** The second table after an action-5 delete left `stem` letters. */
        const scanSecond = (
            stem: number,
            from: number,
            on: number,
            off: number,
        ): void => {
            for (let i = from; i < SECOND.length; i++) {
                const candidate = SECOND[i] as Entry;
                if (!exists(candidate, on, off)) continue;
                const pos = suffixAt(word, stem, candidate);
                if (pos < 0) continue;
                if (candidate.action === 2) add(pos + 1, "s");
                else add(pos);
                const freeOn = candidate.needOn & ~on;
                if (freeOn === 0) return;
                // one fork per condition: the rest is the cell with it off
                scanSecond(stem, i + 1, on, off | freeOn);
                return;
            }
            // nothing in the second table: the delete stands alone
            add(stem);
        };

        /** Applies a fired entry's action. */
        const fire = (fired: Entry, pos: number, on: number, off: number) => {
            switch (fired.action) {
                case 1:
                    add(pos);
                    break;
                case 2:
                    add(pos + 1, "s");
                    break;
                case 3:
                    // szą: deleted in R1, rewritten to s below it
                    if (pos >= p1) add(pos);
                    else add(pos + 1, "s");
                    break;
                case 4:
                    add(pos + 1, "l");
                    break;
                case 5:
                    scanSecond(pos, 0, on, off);
                    break;
                default:
                    throw new Error(`Unknown ending action ${fired.action}`);
            }
        };

        // cells waiting to be scanned: table position, forks on, forks off
        const pending: [number, number, number][] = [[0, 0, 0]];
        const push = (from: number, on: number, off: number) => {
            if (pending.length === MAX_STATES) {
                throw new Error(
                    `More than ${MAX_STATES} pending Polish scan cells`,
                );
            }
            pending.push([from, on, off]);
        };

        /** Scans the main table for one cell of the reading space. */
        const scanMain = (from: number, on: number, off: number): void => {
            for (let i = from; i < MAIN.length; i++) {
                const candidate = MAIN[i] as Entry;
                if (!exists(candidate, on, off)) continue;
                const pos = suffixAt(word, len, candidate);
                if (pos < 0) continue;
                // a failed R1 gate backtracks whether the entry exists or not
                if (candidate.r1Required && pos < p1) continue;
                // the part of the cell where the entry exists fires it...
                fire(
                    candidate,
                    pos,
                    on | candidate.needOn,
                    off | candidate.needOff,
                );
                // ...and the rest scans on, split into conjunction cells
                const freeOn = candidate.needOn & ~on;
                const freeOff = candidate.needOff & ~off;
                if (freeOn === 0 && freeOff === 0) return;
                let accumulatedOn = on;
                let accumulatedOff = off;
                for (let bits = freeOn; bits !== 0; bits &= bits - 1) {
                    const bit = bits & -bits;
                    push(i + 1, accumulatedOn, accumulatedOff | bit);
                    accumulatedOn |= bit;
                }
                for (let bits = freeOff; bits !== 0; bits &= bits - 1) {
                    const bit = bits & -bits;
                    push(i + 1, accumulatedOn | bit, accumulatedOff);
                    accumulatedOff |= bit;
                }
                return;
            }
            // no entry fired: the word keeps its length after the particle
            add(len);
        };

        for (let cell = pending.pop(); cell; cell = pending.pop()) {
            scanMain(...cell);
        }
    }

    variants.add(word);
    if (variants.size > MAX_VARIANTS) {
        // The bound follows from the rules: a breach means the walk no
        // longer mirrors them.
        throw new Error(`More than ${MAX_VARIANTS} Polish stem variants`);
    }
    return [...variants];
}
