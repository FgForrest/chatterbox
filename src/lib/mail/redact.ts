import type { ItemContent } from "@/lib/content/types";
import { resolveLocalPart } from "@/lib/mail/addresses";
import { mailDomain } from "@/lib/mail/config";

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addressPattern(): RegExp {
    return new RegExp(
        `([a-z0-9][a-z0-9.+-]*)@${escapeRegExp(mailDomain())}`,
        "gi",
    );
}

/**
 * A secret address with its token hidden, as long as it was
 * (`jan.••••••••••@klepna.example`), so places in a text stay where they
 * were.
 */
function masked(localPart: string): string {
    const dot = localPart.lastIndexOf(".");
    const kept = dot > 0 ? localPart.slice(0, dot + 1) : "";
    return `${kept}${"•".repeat(localPart.length - kept.length)}@${mailDomain()}`;
}

/**
 * A function hiding the token of every secret address on the mail domain
 * that `texts` mention: whoever learns one can send mail into its owner's
 * pile, so only the owner sees them whole.
 */
export async function secretAddressMasker(
    texts: readonly string[],
): Promise<(text: string) => string> {
    const localParts = new Set<string>();
    for (const text of texts) {
        for (const match of text.matchAll(addressPattern())) {
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
        text.replace(addressPattern(), (whole, localPart: string) =>
            secrets.has(localPart.toLowerCase()) ? masked(localPart) : whole,
        );
}

/** `@` and the local part's `+` and `.` as a URL or markup may write them. */
const ENCODED_ADDRESS_CHARACTERS: readonly [RegExp, string][] = [
    [/%40|&#0*64;|&#x0*40;|&commat;/gi, "@"],
    [/%2b|&#0*43;|&#x0*2b;|&plus;/gi, "+"],
    [/%2e|&#0*46;|&#x0*2e;|&period;/gi, "."],
];

/**
 * `secretAddressMasker` for a mail's HTML, which may write an address
 * URL- or entity-encoded (a link's query, a tracking pixel): finds those
 * too, and hides each secret token wherever it appears, as long as it was.
 */
export async function secretAddressMaskerForHtml(
    html: string,
): Promise<(text: string) => string> {
    let decoded = html;
    for (const [pattern, character] of ENCODED_ADDRESS_CHARACTERS) {
        decoded = decoded.replace(pattern, character);
    }
    const localParts = new Set<string>();
    for (const match of decoded.matchAll(addressPattern())) {
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
    return (text) => text.replace(pattern, (token) => "•".repeat(token.length));
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
