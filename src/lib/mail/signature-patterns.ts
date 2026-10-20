import type { ParsedMailbox } from "@/lib/mail/address-list";

const TITLES =
    /\b(?:ing|mgr|bc|mudr|judr|rndr|phdr|doc|prof|dr|ph\.d)\.?(?=\s|$|[,|])/gi;
const CONTACT_PATTERNS = [
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i,
    /\b(?:www\.|https?:\/\/)\S+/i,
    /(?:^|\W)(?:s\.\s*r\.\s*o\.|a\.\s*s\.|spol\.\s*s\s*r\.\s*o\.|v\.\s*o\.\s*s\.|k\.\s*s\.|gmbh|ltd|inc|llc)(?:$|\W)/i,
    /(?:^|\W)(?:ic|ico|dic|vat)(?:\s+(?:id|no))?\s*[:.]?\s*(?:[a-z]{2})?\d(?:\s?\d){5,}/i,
];
const ADDRESS_PATTERNS = [
    /\b[a-z]{3,}(?: [a-z]+)*\s+\d{1,4}\/\d{1,3}[a-z]?\b/i,
    /\b(?:\d{3} \d{2}\s+[a-z]{2,}|[a-z]{2,}(?: \d{1,2})?,?\s+\d{3} \d{2})\b/i,
];
const CURRENCY = /(?:\b(?:kc|czk|eur|usd)\b|[€$])/i;
const DATE = /\b(?:\d{1,2}[./-]\s*\d{1,2}[./-]\s*\d{2,4}|\d{4}-\d{2}-\d{2})\b/g;
const PHONE = /(?:\+|\b)\d[\d ()-]*\d\b/g;

function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Normalised, non-empty signature lines for comparison across messages. */
export function signatureLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) =>
            fold(line)
                .replace(/[|·•]+|-+/g, " ")
                .replace(/\s+/g, " ")
                .trim(),
        )
        .filter(Boolean);
}

/** Whether a short line contains contact information rather than a price or date. */
export function isContactLine(text: string): boolean {
    const line = fold(text);
    if (CONTACT_PATTERNS.some((pattern) => pattern.test(line))) return true;
    if (CURRENCY.test(line)) return false;
    if (ADDRESS_PATTERNS.some((pattern) => pattern.test(line))) return true;
    return [...line.replace(DATE, "").matchAll(PHONE)].some(
        (match) => match[0].replace(/\D/g, "").length >= 9,
    );
}

/** Whether a line begins with this author's name, allowing titles and reversed names. */
export function startsWithAuthor(
    text: string,
    author: ParsedMailbox | null,
): boolean {
    if (!author || text.length > 80) return false;
    const name =
        fold(author.name)
            .replace(TITLES, "")
            .match(/\p{L}+/gu) ?? [];
    const tokens =
        name.length > 0
            ? name
            : fold(author.address.split("@")[0] ?? "").split(/[._-]/);
    if (
        name.length === 0 &&
        (tokens.length < 2 || tokens.some((token) => token.length < 2))
    )
        return false;
    const withoutTitles = fold(text).replace(TITLES, "").trim();
    if (/[.?!]$/.test(withoutTitles)) return false;
    const words = withoutTitles.match(/\p{L}+/gu) ?? [];
    return (
        tokens.includes(words[0] ?? "") &&
        tokens.every((token) => words.slice(0, 4).includes(token))
    );
}

/** Whether a line looks like a sentence rather than signature metadata. */
export function isSignatureProse(text: string): boolean {
    return /[.?!]$/.test(text.trim()) && (text.match(/\S+/g)?.length ?? 0) >= 8;
}
