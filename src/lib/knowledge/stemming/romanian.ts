/**
 * Romanian stem variants of a word written without diacritics: every stem
 * the word could have had before its accents were dropped, so a name heard
 * inflected ("Bucureștiului", "Ionului", "Mariei") meets the name as written
 * ("București", "Ion", "Maria") whether either side kept its accents.
 *
 * Ported from evitaDB's `RomanianVariantStemmer` (FG Forrest, a.s.; see
 * NOTICE): Snowball's Romanian stemmer, as Lucene ships it, read over the
 * folded alphabet, forking wherever a rule is ambiguous once the accents are
 * gone. The set it returns contains the folded stem Snowball gives every
 * accented spelling of the word, and the word itself.
 *
 * Unlike the Czech walk, the pipeline rewrites letters between steps
 * ("icator" -> "ic", "ism" -> "ist"), so a variant is not just a prefix of
 * the word. The walk is a staged worklist instead: five step gates (step 0,
 * the combo suffixes, the standard suffixes, the verb step, the final vowel)
 * each fork every state into a skipped and an applied successor, and equal
 * successors merge at once, which keeps ordinary words at a state or few.
 * Inside the verb step, three switches decide which entries the table holds
 * (the endings spelled with "ș", those spelled with "ă"/"â" and no plain
 * partner, and which action "am" gets); a matched entry splits the scan
 * over those switches rather than forking blindly, because one switch can be
 * consulted twice on one path ("asesi" skipped, then "sesi" matches).
 *
 * The prelude (intervocalic "i"/"u" marked uppercase) and the regions (RV,
 * R1, R2) are computed once: every edit happens at the tail, so they hold
 * for every fork.
 */

/** At most this many states per stage, pending verb cells, and variants. */
const MAX_STATES = 64;

/** One pipeline state: the marked text, and whether a standard suffix went. */
interface State {
    text: string;
    removed: boolean;
}

/** One suffix entry of a table: the folded suffix and its action code. */
type Ending = readonly [suffix: string, action: number];

/**
 * One entry of the merged verb table: the suffix, its action (1 delete when
 * preceded inside RV by a non-vowel or "u", 2 delete unconditionally), and
 * the switches that must be on and off for the entry to exist.
 */
type VerbEntry = readonly [
    suffix: string,
    action: number,
    needOn: number,
    needOff: number,
];

/** The verb-scan switches; each step gate is consulted once and needs none. */
const S_VERB_ENDINGS = 1;
const A_VERB_ENDINGS = 2;
const AM_UNCONDITIONAL = 4;

/** Longest suffix first; the sort is stable, as Java's is. */
function byLengthDescending<T extends readonly [string, ...unknown[]]>(
    entries: T[],
): T[] {
    return [...entries].sort((a, b) => b[0].length - a[0].length);
}

/** Step 0 endings, Snowball's plural and article removal, gated on R1. */
const STEP0_ENDINGS = byLengthDescending<Ending>([
    ["ea", 3],
    ["atia", 7],
    ["aua", 2],
    ["iua", 4],
    ["atie", 7],
    ["ele", 3],
    ["ile", 5],
    ["iile", 4],
    ["iei", 4],
    ["atei", 6],
    ["ii", 4],
    ["ului", 1],
    ["ul", 1],
    ["elor", 3],
    ["ilor", 4],
    ["iilor", 4],
]);

/** Combo-suffix endings, derivational chains, gated on R1 and repeated. */
const COMBO_ENDINGS = byLengthDescending<Ending>([
    ["icala", 4],
    ["iciva", 4],
    ["ativa", 5],
    ["itiva", 6],
    ["icale", 4],
    ["atiune", 5],
    ["itiune", 6],
    ["atoare", 5],
    ["itoare", 6],
    ["icitate", 4],
    ["abilitate", 1],
    ["ibilitate", 2],
    ["ivitate", 3],
    ["icive", 4],
    ["ative", 5],
    ["itive", 6],
    ["icali", 4],
    ["atori", 5],
    ["icatori", 4],
    ["itori", 6],
    ["icitati", 4],
    ["abilitati", 1],
    ["ivitati", 3],
    ["icivi", 4],
    ["ativi", 5],
    ["itivi", 6],
    ["icitai", 4],
    ["abilitai", 1],
    ["ivitai", 3],
    ["ical", 4],
    ["ator", 5],
    ["icator", 4],
    ["itor", 6],
    ["iciv", 4],
    ["ativ", 5],
    ["itiv", 6],
]);

/** What each combo action rewrites the matched suffix to. */
const COMBO_REPLACEMENTS: Record<number, string> = {
    1: "abil",
    2: "ibil",
    3: "iv",
    4: "ic",
    5: "at",
    6: "it",
};

/** Standard-suffix endings, gated on R2. */
const STANDARD_ENDINGS = byLengthDescending<Ending>([
    ["ica", 1],
    ["abila", 1],
    ["ibila", 1],
    ["oasa", 1],
    ["ata", 1],
    ["ita", 1],
    ["anta", 1],
    ["ista", 3],
    ["uta", 1],
    ["iva", 1],
    ["ic", 1],
    ["ice", 1],
    ["abile", 1],
    ["ibile", 1],
    ["isme", 3],
    ["iune", 2],
    ["oase", 1],
    ["ate", 1],
    ["itate", 1],
    ["ite", 1],
    ["ante", 1],
    ["iste", 3],
    ["ute", 1],
    ["ive", 1],
    ["ici", 1],
    ["abili", 1],
    ["ibili", 1],
    ["iuni", 2],
    ["atori", 1],
    ["osi", 1],
    ["ati", 1],
    ["itati", 1],
    ["iti", 1],
    ["anti", 1],
    ["isti", 3],
    ["uti", 1],
    ["ivi", 1],
    ["itai", 1],
    ["abil", 1],
    ["ibil", 1],
    ["ism", 3],
    ["ator", 1],
    ["os", 1],
    ["at", 1],
    ["it", 1],
    ["ant", 1],
    ["ist", 3],
    ["ut", 1],
    ["iv", 1],
]);

/** Final-vowel endings, gated on RV. */
const VOWEL_ENDINGS = byLengthDescending<Ending>([
    ["ie", 1],
    ["a", 1],
    ["e", 1],
    ["i", 1],
]);

/**
 * Every entry any switch setting's verb table can hold, with the switches
 * of its existence. The two "am" entries carry disjoint conditions, as
 * Snowball gives each spelling one action.
 */
const VERB = byLengthDescending<VerbEntry>([
    // plain entries, present in every setting
    ["ea", 1, 0, 0],
    ["ia", 1, 0, 0],
    ["esc", 1, 0, 0],
    ["ind", 1, 0, 0],
    ["are", 1, 0, 0],
    ["ere", 1, 0, 0],
    ["ire", 1, 0, 0],
    ["se", 2, 0, 0],
    ["ase", 1, 0, 0],
    ["sese", 2, 0, 0],
    ["ise", 1, 0, 0],
    ["use", 1, 0, 0],
    ["eze", 1, 0, 0],
    ["ai", 1, 0, 0],
    ["eai", 1, 0, 0],
    ["iai", 1, 0, 0],
    ["sei", 2, 0, 0],
    ["ui", 1, 0, 0],
    ["ezi", 1, 0, 0],
    ["eati", 1, 0, 0],
    ["iati", 1, 0, 0],
    ["eti", 2, 0, 0],
    ["iti", 2, 0, 0],
    ["serati", 2, 0, 0],
    ["aserati", 1, 0, 0],
    ["seserati", 2, 0, 0],
    ["iserati", 1, 0, 0],
    ["userati", 1, 0, 0],
    ["irati", 1, 0, 0],
    ["urati", 1, 0, 0],
    ["em", 2, 0, 0],
    ["asem", 1, 0, 0],
    ["sesem", 2, 0, 0],
    ["isem", 1, 0, 0],
    ["usem", 1, 0, 0],
    ["im", 2, 0, 0],
    ["au", 1, 0, 0],
    ["eau", 1, 0, 0],
    ["iau", 1, 0, 0],
    ["indu", 1, 0, 0],
    ["ez", 1, 0, 0],
    // folded "am" carries whichever action the switch selects
    ["am", 2, AM_UNCONDITIONAL, 0],
    ["am", 1, 0, AM_UNCONDITIONAL],
    // the endings spelled with "ă"/"â" and no plain partner
    ["asc", 1, A_VERB_ENDINGS, 0],
    ["and", 1, A_VERB_ENDINGS, 0],
    ["andu", 1, A_VERB_ENDINGS, 0],
    ["easca", 1, A_VERB_ENDINGS, 0],
    ["eaza", 1, A_VERB_ENDINGS, 0],
    ["ara", 1, A_VERB_ENDINGS, 0],
    ["sera", 2, A_VERB_ENDINGS, 0],
    ["asera", 1, A_VERB_ENDINGS, 0],
    ["sesera", 2, A_VERB_ENDINGS, 0],
    ["isera", 1, A_VERB_ENDINGS, 0],
    ["usera", 1, A_VERB_ENDINGS, 0],
    ["ira", 1, A_VERB_ENDINGS, 0],
    ["ura", 1, A_VERB_ENDINGS, 0],
    ["ati", 2, A_VERB_ENDINGS, 0],
    ["arati", 1, A_VERB_ENDINGS, 0],
    ["aram", 1, A_VERB_ENDINGS, 0],
    ["seram", 2, A_VERB_ENDINGS, 0],
    ["aseram", 1, A_VERB_ENDINGS, 0],
    ["seseram", 2, A_VERB_ENDINGS, 0],
    ["iseram", 1, A_VERB_ENDINGS, 0],
    ["useram", 1, A_VERB_ENDINGS, 0],
    ["iram", 1, A_VERB_ENDINGS, 0],
    ["uram", 1, A_VERB_ENDINGS, 0],
    // the endings spelled with "ș"
    ["este", 1, S_VERB_ENDINGS, 0],
    ["aste", 1, S_VERB_ENDINGS, 0],
    ["esti", 1, S_VERB_ENDINGS, 0],
    ["asti", 1, S_VERB_ENDINGS, 0],
    ["asi", 1, S_VERB_ENDINGS, 0],
    ["isi", 1, S_VERB_ENDINGS, 0],
    ["usi", 1, S_VERB_ENDINGS, 0],
    ["sesi", 2, S_VERB_ENDINGS, 0],
    ["asesi", 1, S_VERB_ENDINGS, 0],
    ["sesesi", 2, S_VERB_ENDINGS, 0],
    ["isesi", 1, S_VERB_ENDINGS, 0],
    ["usesi", 1, S_VERB_ENDINGS, 0],
]);

/** A folded vowel; the uppercase markers are not, which is their purpose. */
function isVowel(char: string | undefined): boolean {
    return (
        char === "a" ||
        char === "e" ||
        char === "i" ||
        char === "o" ||
        char === "u"
    );
}

/** The prelude: intervocalic "i" and "u" marked uppercase. */
function markIntervocalic(word: string): string {
    const chars = word.split("");
    for (let i = 1; i < chars.length - 1; i++) {
        if (
            (chars[i] === "i" || chars[i] === "u") &&
            isVowel(chars[i - 1]) &&
            isVowel(chars[i + 1])
        ) {
            chars[i] = (chars[i] ?? "").toUpperCase();
        }
    }
    return chars.join("");
}

/** Where RV starts, or the length when the word has none. */
function markRV(s: string): number {
    const len = s.length;
    if (len < 2) return len;
    if (isVowel(s[0])) {
        if (!isVowel(s[1])) {
            for (let i = 2; i < len; i++) {
                if (isVowel(s[i])) return i + 1;
            }
            return len;
        }
        for (let i = 2; i < len; i++) {
            if (!isVowel(s[i])) return i + 1;
        }
        return len;
    }
    if (!isVowel(s[1])) {
        for (let i = 2; i < len; i++) {
            if (isVowel(s[i])) return i + 1;
        }
        return len;
    }
    return len > 2 ? 3 : len;
}

/** Where an R region starts (after a vowel and a non-vowel), or the length. */
function markAfterVowelConsonant(s: string, from: number): number {
    for (let i = from; i < s.length - 1; i++) {
        if (isVowel(s[i]) && !isVowel(s[i + 1])) return i + 2;
    }
    return s.length;
}

/** Adds a state to a stage unless an equal one is there. */
function emit(into: State[], text: string, removed: boolean): void {
    if (
        into.some((state) => state.text === text && state.removed === removed)
    ) {
        return;
    }
    if (into.length === MAX_STATES) {
        // The bound follows from the rules: a breach means the walk no
        // longer mirrors them.
        throw new Error(`More than ${MAX_STATES} Romanian pipeline states`);
    }
    into.push({ text, removed });
}

/** Step 0 applied: the plural and article endings, aborting outside R1. */
function step0Applied(state: State, p1: number, into: State[]): void {
    const { text, removed } = state;
    for (const [suffix, action] of STEP0_ENDINGS) {
        const pos = text.length - suffix.length;
        if (pos < 0 || !text.endsWith(suffix)) continue;
        if (p1 > pos) {
            // the original aborts the whole step on a region failure here
            emit(into, text, removed);
            return;
        }
        const stem = text.slice(0, pos);
        switch (action) {
            case 1:
                emit(into, stem, removed);
                break;
            case 2:
                emit(into, `${stem}a`, removed);
                break;
            case 3:
                emit(into, `${stem}e`, removed);
                break;
            case 4:
                emit(into, `${stem}i`, removed);
                break;
            case 5:
                // "ile" stays after "ab" (abile is derivational, not a plural)
                if (
                    pos >= 2 &&
                    text[pos - 2] === "a" &&
                    text[pos - 1] === "b"
                ) {
                    emit(into, text, removed);
                } else {
                    emit(into, `${stem}i`, removed);
                }
                break;
            case 6:
                emit(into, `${stem}at`, removed);
                break;
            case 7:
                emit(into, `${stem}ati`, removed);
                break;
            default:
                throw new Error(`Unknown step-0 action ${action}`);
        }
        return;
    }
    emit(into, text, removed);
}

/**
 * The combo suffixes applied: rewritten round after round until none
 * matches, a removal if any round fired. Outside R1 the scan goes on to
 * shorter entries, as the port evitaDB mirrors does.
 */
function comboApplied(state: State, p1: number, into: State[]): void {
    let text = state.text;
    let fired = false;
    rounds: while (true) {
        for (const [suffix, action] of COMBO_ENDINGS) {
            const pos = text.length - suffix.length;
            if (pos < 0 || !text.endsWith(suffix)) continue;
            if (p1 > pos) continue;
            const replacement = COMBO_REPLACEMENTS[action];
            if (replacement === undefined) {
                throw new Error(`Unknown combo action ${action}`);
            }
            text = text.slice(0, pos) + replacement;
            fired = true;
            continue rounds;
        }
        break;
    }
    emit(into, text, state.removed || fired);
}

/**
 * The standard suffixes applied, gated on R2. A matched "iune"/"iuni" after
 * "t" forks: the "ț" reading rewrites it away, the "t" one aborts the scan.
 */
function standardApplied(state: State, p2: number, into: State[]): void {
    const { text, removed } = state;
    for (const [suffix, action] of STANDARD_ENDINGS) {
        const pos = text.length - suffix.length;
        if (pos < 0 || !text.endsWith(suffix)) continue;
        // backtrack to shorter entries, as the Snowball stemmer does
        if (p2 > pos) continue;
        switch (action) {
            case 1:
                emit(into, text.slice(0, pos), true);
                break;
            case 2:
                if (pos > 0 && text[pos - 1] === "t") {
                    emit(into, text.slice(0, pos), true);
                }
                emit(into, text, removed);
                break;
            case 3:
                // the "ist" rewrite is a removal even when the length stays
                emit(into, `${text.slice(0, pos)}ist`, true);
                break;
            default:
                throw new Error(`Unknown standard-suffix action ${action}`);
        }
        return;
    }
    emit(into, text, removed);
}

/**
 * Every outcome of the verb step on one state: the scan over the merged
 * table, split into cells of switch settings. A matched entry fires for the
 * cell that holds it; the rest of the cell goes on past it, split by the
 * switches the entry needed. A cell that matches nothing keeps the word.
 */
function verbOutcomes(state: State, pV: number, into: State[]): void {
    const { text, removed } = state;
    const cells: [from: number, on: number, off: number][] = [[0, 0, 0]];
    const push = (from: number, on: number, off: number) => {
        if (cells.length === MAX_STATES) {
            throw new Error(
                `More than ${MAX_STATES} pending Romanian verb cells`,
            );
        }
        cells.push([from, on, off]);
    };
    for (let cell = cells.pop(); cell !== undefined; cell = cells.pop()) {
        const [from, on, off] = cell;
        let fired = false;
        for (let i = from; i < VERB.length; i++) {
            const [suffix, action, needOn, needOff] = VERB[i] as VerbEntry;
            // the entry exists in no setting of this cell
            if ((needOn & off) !== 0 || (needOff & on) !== 0) continue;
            const pos = text.length - suffix.length;
            if (pos < 0 || !text.endsWith(suffix)) continue;
            // outside RV: no match, shorter entries are still tried
            if (pos < pV) continue;
            if (
                action === 1 &&
                !(
                    pos > pV &&
                    (!isVowel(text[pos - 1]) || text[pos - 1] === "u")
                )
            ) {
                continue;
            }
            emit(into, text.slice(0, pos), removed);
            fired = true;
            let accumulatedOn = on;
            let accumulatedOff = off;
            for (let bits = needOn & ~on; bits !== 0; bits &= bits - 1) {
                const bit = bits & -bits;
                push(i + 1, accumulatedOn, accumulatedOff | bit);
                accumulatedOn |= bit;
            }
            for (let bits = needOff & ~off; bits !== 0; bits &= bits - 1) {
                const bit = bits & -bits;
                push(i + 1, accumulatedOn | bit, accumulatedOff);
                accumulatedOff |= bit;
            }
            break;
        }
        if (!fired) emit(into, text, removed);
    }
}

/** The final vowel applied, removed only inside RV. */
function vowelApplied(state: State, pV: number, into: State[]): void {
    const { text, removed } = state;
    for (const [suffix] of VOWEL_ENDINGS) {
        const pos = text.length - suffix.length;
        if (pos >= 0 && text.endsWith(suffix)) {
            emit(into, pos < pV ? text : text.slice(0, pos), removed);
            return;
        }
    }
    emit(into, text, removed);
}

/** Runs one gate: every state both skips it and goes through it. */
function gate(
    current: State[],
    applied: (state: State, into: State[]) => void,
): State[] {
    const next: State[] = [];
    for (const state of current) {
        emit(next, state.text, state.removed);
        applied(state, next);
    }
    return next;
}

/**
 * The Romanian stem variants of a lowercase word without diacritics, the
 * word itself included.
 */
export function romanianVariants(word: string): string[] {
    const master = markIntervocalic(word);
    const pV = markRV(master);
    const p1 = markAfterVowelConsonant(master, 0);
    const p2 = markAfterVowelConsonant(master, p1);

    let states: State[] = [{ text: master, removed: false }];
    states = gate(states, (state, into) => step0Applied(state, p1, into));
    states = gate(states, (state, into) => comboApplied(state, p1, into));
    states = gate(states, (state, into) => standardApplied(state, p2, into));
    // the verb step runs only where no standard suffix was removed
    states = gate(states, (state, into) => {
        if (!state.removed) verbOutcomes(state, pV, into);
    });
    states = gate(states, (state, into) => vowelApplied(state, pV, into));

    const variants = new Set<string>();
    for (const state of states) {
        variants.add(state.text.replaceAll("I", "i").replaceAll("U", "u"));
    }
    variants.add(word);
    if (variants.size > MAX_STATES) {
        throw new Error(`More than ${MAX_STATES} Romanian stem variants`);
    }
    return [...variants];
}
