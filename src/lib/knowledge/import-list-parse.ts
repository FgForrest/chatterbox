/**
 * Reading a pasted list for an import (`import-list.ts`): one line per
 * type, the names after a colon, nicknames in parentheses. Pure, so the
 * preview's rules are tested without a database.
 */

/** A name as the list gave it. */
export interface ParsedName {
    line: number;
    /** The type as written before the colon. */
    typeText: string;
    name: string;
    nicknames: string[];
}

/** A line the list could not read. */
export interface ParseProblem {
    line: number;
    text: string;
}

/** Split on commas outside parentheses. */
function splitNames(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of text) {
        if (char === "(") depth++;
        if (char === ")") depth = Math.max(0, depth - 1);
        if ((char === "," || char === ";") && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Read the list: every name with its line, type and nicknames, and the
 * lines it could not read. Blank lines and lines starting with `#` are
 * skipped.
 */
export function parseImportList(text: string): {
    names: ParsedName[];
    problems: ParseProblem[];
} {
    const names: ParsedName[] = [];
    const problems: ParseProblem[] = [];
    text.split(/\r?\n/).forEach((raw, index) => {
        const line = index + 1;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const colon = trimmed.indexOf(":");
        const typeText = colon > 0 ? trimmed.slice(0, colon).trim() : "";
        const rest = colon > 0 ? trimmed.slice(colon + 1) : "";
        const items = splitNames(rest);
        if (!typeText || items.length === 0) {
            problems.push({ line, text: trimmed });
            return;
        }
        for (const item of items) {
            const open = item.indexOf("(");
            const close = item.indexOf(")");
            // Nicknames are one closed group at the end: "Name (nick",
            // "Name) (nick)" or "Name (nick) more" is a line to fix, not
            // a name or nickname with a stray bracket in it.
            if (
                (open >= 0 || close >= 0) &&
                (open < 0 ||
                    close < open ||
                    item.indexOf("(", open + 1) >= 0 ||
                    item.indexOf(")", close + 1) >= 0 ||
                    item.slice(close + 1).trim())
            ) {
                problems.push({ line, text: item });
                continue;
            }
            const name = (open >= 0 ? item.slice(0, open) : item)
                .trim()
                .replace(/\s+/g, " ");
            const inner = open >= 0 ? item.slice(open + 1, close) : "";
            const nicknames = inner
                .split(/[,;]/)
                .map((nickname) => nickname.trim().replace(/\s+/g, " "))
                .filter(Boolean);
            if (!name) {
                problems.push({ line, text: item });
                continue;
            }
            names.push({ line, typeText, name, nicknames });
        }
    });
    return { names, problems };
}

/** Lowercase without diacritics, for matching what people type. */
export function fold(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .trim();
}

/**
 * What the core types are also called, so a list typed in Czech, or with
 * plurals, still reads. Labels and keys match too, whatever the language.
 */
const TYPE_WORDS: Record<string, string> = {
    people: "person",
    persons: "person",
    osoba: "person",
    osoby: "person",
    clovek: "person",
    lide: "person",
    organizations: "organization",
    organizace: "organization",
    firma: "organization",
    firmy: "organization",
    company: "organization",
    companies: "organization",
    teams: "team",
    tym: "team",
    tymy: "team",
    projects: "project",
    projekt: "project",
    projekty: "project",
    products: "product",
    produkt: "product",
    produkty: "product",
    system: "product",
    systemy: "product",
    terms: "term",
    pojem: "term",
    pojmy: "term",
    termin: "term",
    terminy: "term",
    locations: "location",
    misto: "location",
    mista: "location",
    lokalita: "location",
    documents: "document",
    dokument: "document",
    dokumenty: "document",
};

/** The type key a list's word names among `types`, or null. */
export function resolveImportType(
    typeText: string,
    types: readonly { key: string; label: string }[],
): string | null {
    const word = fold(typeText);
    const direct = types.find(
        (type) => fold(type.key) === word || fold(type.label) === word,
    );
    if (direct) return direct.key;
    const alias = TYPE_WORDS[word];
    return alias && types.some((type) => type.key === alias) ? alias : null;
}
