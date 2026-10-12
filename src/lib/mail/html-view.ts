import { simpleParser } from "mailparser";

/** Inline images larger than this stay out (one each, and in total). */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

/** `cid:` references of `html` replaced by data URIs of inline images. */
function inlineImages(
    html: string,
    images: ReadonlyMap<string, string>,
): string {
    return html.replace(
        /(["'])cid:([^"']+)\1/gi,
        (_match, quote: string, cid: string) => {
            const uri = images.get(cid.trim().toLowerCase());
            return uri ? `${quote}${uri}${quote}` : `${quote}${quote}`;
        },
    );
}

/**
 * A mail's HTML with its `cid:` images as data URIs, NOT sanitized: it is
 * only ever sent to the browser as JSON, where `mailHtmlDocument`
 * sanitizes it before an empty-`sandbox` iframe shows it. Null when the
 * mail has no HTML.
 */
export async function mailHtmlBody(raw: Buffer): Promise<string | null> {
    const mail = await simpleParser(raw, {
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
        keepCidLinks: true,
    });
    if (!mail.html) return null;
    const images = new Map<string, string>();
    let total = 0;
    for (const attachment of mail.attachments) {
        const cid = (attachment.contentId ?? attachment.cid ?? "")
            .replace(/^<|>$/g, "")
            .trim()
            .toLowerCase();
        if (!cid || !attachment.contentType.startsWith("image/")) continue;
        if (
            attachment.size > MAX_INLINE_IMAGE_BYTES ||
            total + attachment.size > MAX_INLINE_TOTAL_BYTES
        ) {
            continue;
        }
        total += attachment.size;
        images.set(
            cid,
            `data:${attachment.contentType};base64,${attachment.content.toString("base64")}`,
        );
    }
    return inlineImages(mail.html, images);
}
