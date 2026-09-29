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
    "ata",
    "ete",
    "eti",
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

/** A transcript's words, as `nameWords` gives them, each with its capital. */
export function nameTokens(text: string): { word: string; capital: boolean }[] {
    return text
        .split(/[^\p{L}\p{N}\p{M}]+/u)
        .filter(Boolean)
        .map((raw) => ({
            word: nameWords(raw).join(""),
            capital: /^\p{Lu}/u.test(raw),
        }))
        .filter((token) => token.word);
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

/** Whether a transcript word is `part` (one word of a name), inflected. */
export function isNameWord(word: string, part: string): boolean {
    if (word === part) return true;
    return stems(part).some(
        (stem) => word.startsWith(stem) && ENDINGS.has(word.slice(stem.length)),
    );
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
 * after the first, written with a capital) or a nickname of theirs is
 * among them. A one-word name is a first name alone unless a nickname is
 * heard.
 */
export function moreThanFirstName(
    tokens: readonly { word: string; capital: boolean }[],
    person: { name: string; aliases?: readonly string[] },
): boolean {
    const rest = nameParts(person.name).slice(1);
    if (
        rest.some((part) =>
            tokens.some(
                (token) => token.capital && isNameWord(token.word, part),
            ),
        )
    ) {
        return true;
    }
    const words = tokens.map((token) => token.word);
    return usableAliases(person.aliases).some((alias) =>
        aliasAmong(words, alias),
    );
}
