import type { ItemContent } from "@/lib/content/types";
import { env } from "@/lib/env";
import { resolveLocalPart } from "@/lib/mail/addresses";

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addressPattern(domain: string): RegExp {
    return new RegExp(`([a-z0-9][a-z0-9.+-]*)@${escapeRegExp(domain)}`, "gi");
}

/**
 * A secret address with its token hidden, as long as it was
 * (`jan.••••••••••@klepna.example`), so places in a text stay where they
 * were.
 */
function masked(localPart: string, domain: string): string {
    const dot = localPart.lastIndexOf(".");
    const kept = dot > 0 ? localPart.slice(0, dot + 1) : "";
    return `${kept}${"•".repeat(localPart.length - kept.length)}@${domain}`;
}

/**
 * A function hiding the token of every secret address on the mail domain
 * that `texts` mention: whoever learns one can send mail into its owner's
 * pile, so only the owner sees them whole.
 */
export async function secretAddressMasker(
    texts: readonly string[],
): Promise<(text: string) => string> {
    const domain = env.MAIL_DOMAIN;
    if (!domain) return (text) => text;
    const localParts = new Set<string>();
    for (const text of texts) {
        for (const match of text.matchAll(addressPattern(domain))) {
            if (match[1]) localParts.add(match[1].toLowerCase());
        }
    }
    const secrets = new Set<string>();
    for (const localPart of localParts) {
        if ((await resolveLocalPart(localPart))?.kind === "secret") {
            secrets.add(localPart);
        }
    }
    if (secrets.size === 0) return (text) => text;
    return (text) =>
        text.replace(addressPattern(domain), (whole, localPart: string) =>
            secrets.has(localPart.toLowerCase())
                ? masked(localPart, domain)
                : whole,
        );
}

/** A numeric character reference, with or without its semicolon. */
const CHARACTER_REFERENCE = /&#(?:x([0-9a-f]+)|([0-9]+));?/gi;

/** Named references to the characters an address is written with. */
const NAMED_ADDRESS_REFERENCES: Readonly<Record<string, string>> = {
    "&commat;": "@",
    "&period;": ".",
    "&plus;": "+",
    "&hyphen;": "-",
};

/**
 * `html` with each character reference to a letter, digit, `@`, `.`, `+`
 * or `-` written as that character, which means the same in markup.
 */
function withAddressCharactersPlain(html: string): string {
    return html
        .replace(
            CHARACTER_REFERENCE,
            (whole, hex?: string, decimal?: string) => {
                const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
                if (!Number.isInteger(code) || code > 0x7f) return whole;
                const character = String.fromCharCode(code);
                return /[a-z0-9@.+-]/i.test(character) ? character : whole;
            },
        )
        .replace(
            /&(?:commat|period|plus|hyphen);/gi,
            (name) => NAMED_ADDRESS_REFERENCES[name.toLowerCase()] ?? name,
        );
}

/** `text` percent-decoded as often as it was encoded (`%2540` is `@`). */
function percentDecoded(text: string): string {
    let current = text;
    for (let round = 0; round < 4; round++) {
        const next = current.replace(
            /%([0-9a-f]{2})/gi,
            (_whole, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
        );
        if (next === current) break;
        current = next;
    }
    return current;
}

/**
 * `secretAddressMasker` for a mail's HTML, which may write an address with
 * character references or percent-encoded (a link's query, a tracking
 * pixel): finds those too, and hides each secret token wherever it
 * appears. The HTML it returns has those references written plainly;
 * other encodings (base64, say) stay hidden from it.
 */
export async function secretAddressMaskerForHtml(
    html: string,
): Promise<(text: string) => string> {
    const domain = env.MAIL_DOMAIN;
    if (!domain) return (text) => text;
    const decoded = percentDecoded(withAddressCharactersPlain(html));
    const localParts = new Set<string>();
    for (const match of decoded.matchAll(addressPattern(domain))) {
        if (match[1]) localParts.add(match[1].toLowerCase());
    }
    const tokens = new Set<string>();
    for (const localPart of localParts) {
        if ((await resolveLocalPart(localPart))?.kind === "secret") {
            tokens.add(localPart.slice(localPart.lastIndexOf(".") + 1));
        }
    }
    if (tokens.size === 0) return (text) => text;
    const pattern = new RegExp([...tokens].map(escapeRegExp).join("|"), "gi");
    return (text) =>
        withAddressCharactersPlain(text).replace(pattern, (token) =>
            "•".repeat(token.length),
        );
}

/**
 * A mail's content with every secret address masked, for a model to read:
 * a token a summary repeated would reach whoever reads the summary. Same
 * lengths, so a quote the model gives back is found at the same place.
 */
export async function maskedContentForModel<
    T extends Pick<ItemContent, "segments" | "participants">,
>(content: T): Promise<T> {
    const mask = await secretAddressMasker([
        ...content.segments.map((segment) => segment.text),
        // A sender names themselves as they like, an address included.
        ...content.participants.map(
            (participant) => participant.displayName ?? "",
        ),
    ]);
    return {
        ...content,
        participants: content.participants.map((participant) => ({
            ...participant,
            displayName: participant.displayName
                ? mask(participant.displayName)
                : participant.displayName,
        })),
        segments: content.segments.map((segment) => ({
            ...segment,
            text: mask(segment.text),
        })),
    };
}
