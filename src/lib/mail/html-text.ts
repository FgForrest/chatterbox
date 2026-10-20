/**
 * A mail's HTML as text, for reading and segmenting, with the places a
 * client marked as quoted kept as markers: `QUOTE_OPEN` and `QUOTE_CLOSE`
 * lines around each quoted part (Gmail's `gmail_quote`, a `blockquote`,
 * Outlook's reply divider), `SIGNATURE_OPEN` and `SIGNATURE_CLOSE` around a
 * client's signature container, and `SIGNATURE_START` where classic
 * Outlook's signature begins. Nothing here is ever rendered as HTML.
 */

export const QUOTE_OPEN = "\u0001quote-open\u0001";
export const QUOTE_CLOSE = "\u0001quote-close\u0001";
export const SIGNATURE_OPEN = "\u0001signature-open\u0001";
export const SIGNATURE_CLOSE = "\u0001signature-close\u0001";
export const SIGNATURE_START = "\u0001signature-start\u0001";

const BLOCK_TAGS = new Set([
    "address",
    "article",
    "aside",
    "dd",
    "div",
    "dl",
    "dt",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul",
]);

const SKIPPED_TAGS = new Set(["head", "script", "style", "title", "template"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    laquo: "«",
    raquo: "»",
    bdquo: "„",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
    copy: "©",
    reg: "®",
    euro: "€",
};

/** Decodes the character references of `text`. */
export function decodeEntities(text: string): string {
    return text.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
        (match, ref: string) => {
            if (ref[0] === "#") {
                const code =
                    ref[1] === "x" || ref[1] === "X"
                        ? Number.parseInt(ref.slice(2), 16)
                        : Number.parseInt(ref.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                    ? String.fromCodePoint(code)
                    : match;
            }
            return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
        },
    );
}

interface Tag {
    name: string;
    closing: boolean;
    attributes: string;
}

function parseTag(raw: string): Tag | null {
    const match = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)([\s\S]*?)\/?\s*>$/i.exec(
        raw,
    );
    if (!match) return null;
    return {
        name: (match[2] ?? "").toLowerCase(),
        closing: match[1] === "/",
        attributes: match[3] ?? "",
    };
}

function attribute(tag: Tag, name: string): string {
    const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    for (const match of tag.attributes.matchAll(pattern)) {
        if (match[1]?.toLowerCase() === name) {
            return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
        }
    }
    return "";
}

/**
 * Whether an opening tag starts a quoted part. Every client wraps the
 * quoted message itself in a `blockquote` (Gmail's `gmail_quote`, Apple
 * Mail's and Thunderbird's `type="cite"`); the containers around it hold
 * the reply header, which the segmenter reads as text, and Outlook's and
 * Gmail's forwards carry no quote markup at all.
 */
function opensQuote(tag: Tag): boolean {
    return tag.name === "blockquote";
}

/**
 * Whether an opening tag is a client's signature container: Gmail's
 * `gmail_signature`, Outlook's `Signature` id, Thunderbird's
 * `moz-signature`, Apple Mail's `AppleMailSignature`.
 */
function opensSignature(tag: Tag): boolean {
    const classes = attribute(tag, "class");
    return (
        classes.includes("gmail_signature") ||
        attribute(tag, "data-smartmail") === "gmail_signature" ||
        ["Signature", "signature", "AppleMailSignature"].includes(
            attribute(tag, "id"),
        ) ||
        (["div", "pre"].includes(tag.name) && classes.includes("moz-signature"))
    );
}

/**
 * The text of `html` as a browser would lay it out in lines: a block
 * boundary breaks a line that has text, a `<br>` breaks one always (so an
 * empty `<div><br></div>` is an empty line), a paragraph is followed by a
 * blank line. Quote and signature containers sit between marker lines;
 * classic Outlook's signature bookmark emits an open-only start marker.
 */
export function htmlToText(html: string): string {
    const out: string[] = [];
    const stack: { name: string; quote: boolean; signature: boolean }[] = [];
    let skipping: string | null = null;
    let skipDepth = 0;
    let quoteDepth = 0;
    let lineHasText = false;
    const breakLine = () => {
        if (lineHasText) out.push("\n");
        lineHasText = false;
    };
    const marker = (value: string) => {
        breakLine();
        out.push(`${value}\n`);
    };
    const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
    for (const token of tokens) {
        if (token.startsWith("<!--")) continue;
        if (token.startsWith("<")) {
            const tag = parseTag(token);
            if (!tag) continue;
            const selfClosing = /\/\s*>$/.test(token);
            if (skipping) {
                if (tag.name === skipping && !selfClosing) {
                    skipDepth += tag.closing ? -1 : 1;
                    if (skipDepth === 0) skipping = null;
                }
                continue;
            }
            if (
                !tag.closing &&
                (SKIPPED_TAGS.has(tag.name) ||
                    attribute(tag, "class").includes("gmail_signature_prefix"))
            ) {
                if (!selfClosing) {
                    skipping = tag.name;
                    skipDepth = 1;
                }
                continue;
            }
            if (tag.name === "br") {
                out.push("\n");
                lineHasText = false;
                continue;
            }
            if (!tag.closing) {
                const quote = opensQuote(tag);
                const signature = opensSignature(tag);
                if (signature) marker(SIGNATURE_OPEN);
                if (
                    tag.name === "a" &&
                    attribute(tag, "name") === "_MailAutoSig"
                ) {
                    marker(SIGNATURE_START);
                }
                if (quote) {
                    quoteDepth++;
                    marker(QUOTE_OPEN);
                } else if (tag.name === "p") {
                    if (lineHasText) out.push("\n\n");
                    lineHasText = false;
                } else if (BLOCK_TAGS.has(tag.name)) {
                    breakLine();
                } else if (tag.name === "td" || tag.name === "th") {
                    if (lineHasText) out.push(" ");
                }
                if (!selfClosing && tag.name !== "hr") {
                    stack.push({ name: tag.name, quote, signature });
                }
                continue;
            }
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i]?.name !== tag.name) continue;
                for (const closed of stack.splice(i).reverse()) {
                    if (closed.signature) marker(SIGNATURE_CLOSE);
                    if (closed.quote) {
                        quoteDepth--;
                        marker(QUOTE_CLOSE);
                    }
                }
                break;
            }
            if (tag.name === "p") {
                if (lineHasText) out.push("\n\n");
                lineHasText = false;
            } else if (BLOCK_TAGS.has(tag.name)) {
                breakLine();
            }
            continue;
        }
        if (skipping) continue;
        const text = decodeEntities(token.replace(/\s+/g, " "));
        if (!text.trim()) {
            if (lineHasText) out.push(" ");
            continue;
        }
        out.push(lineHasText ? text : text.replace(/^\s+/, ""));
        lineHasText = true;
    }
    while (quoteDepth-- > 0) marker(QUOTE_CLOSE);
    return out
        .join("")
        .split("\n")
        .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
