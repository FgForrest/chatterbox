/**
 * Whether words in a transcript are a person's or a thing's name, as
 * Czech says it: inflected ("Bednářovi", "Hrubcovou"), with the "e" some
 * surnames drop ("Hájek" → "Hájka", "Němec" → "Němcovi"), and without
 * titles or initials ("Ing.", "F."). Pure; conservative on purpose: a
 * common word that merely starts like a name ("nová" for "Novák", "dost"
 * for "Dostál") is not the name, and in a transcript a surname is written
 * with a capital, as Czech writes names ("veselé" is not "Veselý").
 */

const TITLES = new Set([
    "ing",
    "mgr",
    "bc",
    "dr",
    "phd",
    "judr",
    "mudr",
    "rndr",
    "phdr",
    "prof",
    "doc",
    "jr",
    "sr",
    "dis",
    "csc",
    "drsc",
    "arch",
    "mba",
    "paeddr",
    "thdr",
]);

/**
 * The endings Czech declension puts after a name's stem (diacritics gone):
 * "Bednářovi", "Hrubcovou", "Zeleného", "Hájka", "Michale". Anything
 * else after the stem is another word ("Janoušek" is not "Jan").
 */
const ENDINGS = new Set([
    "",
    "a",
    "e",
    "i",
    "o",
    "u",
    "y",
    "em",
    "ou",
    "am",
    "im",
    "ym",
    "ami",
    "imi",
    "ymi",
    "ech",
    "ich",
    "ych",
    "eho",
    "emu",
    "yho",
    "ymu",
    "ovi",
    "ova",
    "ove",
    "ovu",
    "ovy",
    "ovou",
    "ovym",
    "ovych",
    "ovymi",
    "uv",
    "iho",
    "imu",
    "ata",
    "ete",
    "eti",
]);
/**
 * Endings only an adjective takes ("Dubových stolů", "Zeleného"). A word
 * starting a sentence is written with a capital whatever it is, so there a
 * capital with one of these is no sign of a surname.
 */
const ADJECTIVAL = new Set([
    "ym",
    "ymi",
    "ych",
    "eho",
    "emu",
    "yho",
    "ymu",
    "iho",
    "imu",
    "ich",
    "imi",
    "ovym",
    "ovych",
    "ovymi",
]);
const VOWELS = /[aeiouy]+$/;
const DROPPED_E = /^(.*[^aeiouy])e([^aeiouy])$/;
/** Consonants that change before an ending: "Procházka" → "Procházce". */
const ALTERNATIONS: [RegExp, string][] = [
    [/k$/, "c"],
    [/h$/, "z"],
    [/g$/, "z"],
];

/** Letters only, lower case, without diacritics. */
export function nameWords(text: string): string[] {
    return text
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

export interface NameToken {
    word: string;
    capital: boolean;
    /** The first word of a sentence, capitalized whatever it is. */
    initial: boolean;
}

/**
 * A transcript's words, as `nameWords` gives them, each with its capital
 * and whether it starts a sentence.
 */
export function nameTokens(text: string): NameToken[] {
    const tokens: NameToken[] = [];
    let initial = true;
    let previous = "";
    for (const [raw] of text.matchAll(/[\p{L}\p{N}\p{M}]+|[.!?…]/gu)) {
        if (/^[.!?…]$/u.test(raw)) {
            // Not the period of a title or an initial ("Ing. Novák").
            if (
                !(
                    raw === "." &&
                    (previous.length === 1 || TITLES.has(previous))
                )
            ) {
                initial = true;
            }
            previous = "";
            continue;
        }
        const word = nameWords(raw).join("");
        if (!word) continue;
        tokens.push({ word, capital: /^\p{Lu}/u.test(raw), initial });
        initial = false;
        previous = word;
    }
    return tokens;
}

/** A name's own words: no titles, no initials. */
export function nameParts(name: string): string[] {
    return nameWords(name).filter(
        (word) => word.length > 1 && !TITLES.has(word),
    );
}

/** The stems an inflected form of `part` starts with. */
function stems(part: string): string[] {
    const found = new Set<string>();
    const base = part.replace(VOWELS, "") || part;
    found.add(base);
    const dropped = DROPPED_E.exec(base);
    if (dropped) found.add(`${dropped[1]}${dropped[2]}`);
    for (const stem of [...found]) {
        for (const [ending, instead] of ALTERNATIONS) {
            if (ending.test(stem)) found.add(stem.replace(ending, instead));
        }
    }
    return [...found].filter((stem) => stem.length >= 3);
}

/** The ending a transcript word puts after `part`'s stem, if it is `part`. */
function endingOf(word: string, part: string): string | null {
    if (word === part) return "";
    for (const stem of stems(part)) {
        const ending = word.slice(stem.length);
        if (word.startsWith(stem) && ENDINGS.has(ending)) return ending;
    }
    return null;
}

/** Whether a transcript word is `part` (one word of a name), inflected. */
export function isNameWord(word: string, part: string): boolean {
    return endingOf(word, part) !== null;
}

/**
 * Whether `heard` is exactly the name (every word of it, in order, as
 * inflected), so linking it would tell nobody anything new.
 */
export function heardIsTheName(heard: string, name: string): boolean {
    const words = nameWords(heard);
    const parts = nameParts(name);
    return (
        parts.length > 0 &&
        words.length === parts.length &&
        words.every((word, index) => isNameWord(word, parts[index] ?? ""))
    );
}

/** Nicknames long enough to tell apart from ordinary words ("Jo" is not). */
function usableAliases(aliases: readonly string[] = []): string[][] {
    return aliases
        .map((alias) => nameWords(alias))
        .filter((words) => words.join("").length >= 3);
}

function aliasAmong(words: readonly string[], alias: readonly string[]) {
    if (alias.length === 1) {
        return words.some((word) => isNameWord(word, alias[0] ?? ""));
    }
    return words.some((_, start) =>
        alias.every((part, offset) =>
            isNameWord(words[start + offset] ?? "", part),
        ),
    );
}

/**
 * Whether `heard` names a person by their first name alone: its words are
 * that first name (inflected), not their surname nor a nickname of theirs.
 */
export function heardIsFirstNameOnly(
    heard: string,
    person: { name: string; aliases?: readonly string[] },
): boolean {
    const words = nameWords(heard);
    const [first, ...rest] = nameParts(person.name);
    // A one-word name is all there is: nothing tells a first name from it.
    if (!first || rest.length === 0 || words.length === 0) return false;
    if (
        usableAliases(person.aliases).some((alias) => aliasAmong(words, alias))
    ) {
        return false;
    }
    if (rest.some((part) => words.some((word) => isNameWord(word, part)))) {
        return false;
    }
    return words.every((word) => isNameWord(word, first));
}

/**
 * Whether more than a first name backs naming this person in these words
 * (`nameTokens` of a transcript): their surname (any word of the name
 * after the first, written with a capital, and not merely an adjective
 * starting a sentence) or a nickname of theirs is among them. A one-word
 * name is a first name alone unless a nickname is heard.
 */
export function moreThanFirstName(
    tokens: readonly NameToken[],
    person: { name: string; aliases?: readonly string[] },
): boolean {
    const rest = nameParts(person.name).slice(1);
    const surname = (token: NameToken, part: string) => {
        if (!token.capital) return false;
        const ending = endingOf(token.word, part);
        return ending !== null && !(token.initial && ADJECTIVAL.has(ending));
    };
    if (rest.some((part) => tokens.some((token) => surname(token, part)))) {
        return true;
    }
    const words = tokens.map((token) => token.word);
    return usableAliases(person.aliases).some((alias) =>
        aliasAmong(words, alias),
    );
}
