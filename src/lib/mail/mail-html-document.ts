import createDOMPurify, {
    type Config,
    type DOMPurify,
    type WindowLike,
} from "dompurify";

/** What the formatted mail's frame may load: inline styles and data: images, nothing else. */
export const MAIL_CSP =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'";

/** A CSS value without anything that fetches: no url(), image-set(), @import. */
const SAFE_CSS_VALUE =
    /^(?!.*(url\s*\(|image-set|expression\s*\(|@import|\\)).*$/i;

const STYLE_PROPERTIES = new Set([
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "text-align",
    "text-decoration",
    "text-transform",
    "vertical-align",
    "white-space",
    "width",
    "max-width",
    "height",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-collapse",
    "border-color",
    "border-radius",
    "border-spacing",
    "border-style",
    "border-width",
    "display",
    "list-style-type",
]);

const ALLOWED_TAGS = [
    "address",
    "article",
    "aside",
    "footer",
    "header",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hgroup",
    "main",
    "nav",
    "section",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "hr",
    "li",
    "menu",
    "ol",
    "p",
    "pre",
    "ul",
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "br",
    "cite",
    "code",
    "data",
    "dfn",
    "em",
    "i",
    "kbd",
    "mark",
    "q",
    "rb",
    "rp",
    "rt",
    "rtc",
    "ruby",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "time",
    "u",
    "var",
    "wbr",
    "caption",
    "col",
    "colgroup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "img",
    "font",
    "center",
];

/** Attributes any allowed element may keep. */
const GLOBAL_ATTRIBUTES = new Set([
    "style",
    "align",
    "valign",
    "width",
    "height",
    "bgcolor",
    "dir",
    "lang",
    "title",
]);

/** Attributes only these elements may keep. */
const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
    a: new Set(["href", "name"]),
    img: new Set(["src", "alt", "width", "height"]),
    font: new Set(["face", "size", "color"]),
    td: new Set(["colspan", "rowspan"]),
    th: new Set(["colspan", "rowspan"]),
    table: new Set(["border", "cellpadding", "cellspacing"]),
    ol: new Set(["start", "type"]),
};

const ALLOWED_ATTR = [
    ...GLOBAL_ATTRIBUTES,
    ...Object.values(TAG_ATTRIBUTES).flatMap((names) => [...names]),
];

const CONFIG: Config = {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: ["style"],
    KEEP_CONTENT: true,
    WHOLE_DOCUMENT: false,
};

/** A URL's scheme ("https"), or null for a relative URL. */
function schemeOf(url: string): string | null {
    const compact = url
        // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers skip these in URLs
        .replace(/[\u0000- \u007f]/g, "")
        .replace(/\\/g, "/");
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
    if (match) return (match[1] ?? "").toLowerCase();
    return compact.startsWith("//") ? "//" : null;
}

/** Whether a link may point there: the web, mail, or a place in the mail itself. */
function allowedHref(url: string): boolean {
    const scheme = schemeOf(url);
    return scheme === null || ["http", "https", "mailto"].includes(scheme);
}

/** Splits a style attribute into declarations, outside quotes and parentheses. */
function declarations(style: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    let depth = 0;
    for (const char of style) {
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth = Math.max(0, depth - 1);
        } else if (char === ";" && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/** The style's allowed declarations: known properties, values that fetch nothing. */
function safeStyle(style: string): string {
    const kept: string[] = [];
    for (const declaration of declarations(style)) {
        const colon = declaration.indexOf(":");
        if (colon <= 0) continue;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        if (!value || !STYLE_PROPERTIES.has(property)) continue;
        if (!SAFE_CSS_VALUE.test(value) || /[<>]|\/\*/.test(value)) continue;
        kept.push(`${property}:${value}`);
    }
    return kept.join(";");
}

/**
 * A DOMPurify instance on `window` with the mail rules: the allowed tags,
 * each attribute only where it belongs, links to the web or mail only,
 * images only as data: URIs, styles without anything that fetches.
 */
export function createMailPurifier(window: WindowLike): DOMPurify {
    const purifier = createDOMPurify(window);
    purifier.addHook("uponSanitizeAttribute", (node, event) => {
        const tag = node.nodeName.toLowerCase();
        const name = event.attrName;
        if (!GLOBAL_ATTRIBUTES.has(name) && !TAG_ATTRIBUTES[tag]?.has(name)) {
            event.keepAttr = false;
            return;
        }
        if (name === "href" && !allowedHref(event.attrValue)) {
            event.keepAttr = false;
        } else if (
            name === "src" &&
            !event.attrValue.toLowerCase().startsWith("data:image/")
        ) {
            event.keepAttr = false;
        } else if (name === "style") {
            const style = safeStyle(event.attrValue);
            if (style) event.attrValue = style;
            else event.keepAttr = false;
        }
    });
    purifier.addHook("afterSanitizeAttributes", (node) => {
        if (node.nodeName.toLowerCase() === "a") {
            (node as Element).setAttribute(
                "rel",
                "noopener noreferrer nofollow",
            );
        }
    });
    return purifier;
}

let browserPurifier: DOMPurify | null = null;

/** The page's purifier, made once (hooks added again would run twice). */
function purifierOfThisPage(): DOMPurify | null {
    if (typeof window === "undefined") return null;
    browserPurifier ??= createMailPurifier(window);
    return browserPurifier;
}

/**
 * A mail's HTML, as the server hands it over (unsanitized, `cid:` images
 * already data URIs), made a self-contained document for an
 * empty-`sandbox` iframe's `srcdoc`: sanitized by the mail rules, under a
 * CSP that allows nothing else. Null where DOMPurify cannot run, which
 * would otherwise return the HTML untouched.
 */
export function mailHtmlDocument(
    html: string,
    purifier: DOMPurify | null = purifierOfThisPage(),
): string | null {
    if (!purifier?.isSupported) return null;
    const body = purifier.sanitize(html, CONFIG);
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;margin:0;padding:12px;color:#111;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:2px solid #ccc;color:#555}</style></head><body>${body}</body></html>`;
}
