export type TextLinkSegment =
    | { type: "text"; text: string; start: number }
    | {
          type: "link";
          text: string;
          start: number;
          href: string;
          label: string;
      };

const labelLimit = 60;
const closingPairs: Record<string, string> = {
    ")": "(",
    "]": "[",
    "}": "{",
    "”": "“",
    "’": "‘",
    "‘": "‚",
    "“": "„",
    "»": "«",
    "›": "‹",
};

function trimEnd(candidate: string): string {
    let end = candidate.length;
    while (end) {
        const last = candidate[end - 1];
        if (/[.,;:!?]/u.test(last)) {
            end--;
            continue;
        }
        const opener = closingPairs[last];
        if (opener) {
            const part = candidate.slice(0, end);
            if (part.split(last).length > part.split(opener).length) {
                end--;
                continue;
            }
        }
        if (last === '"' || last === "'" || last === "`") {
            const count = candidate.slice(0, end).split(last).length - 1;
            if (count % 2) {
                end--;
                continue;
            }
        }
        break;
    }
    return candidate.slice(0, end);
}

/** Split plain text into safe web links and text without altering the source. */
export function splitTextLinks(text: string): TextLinkSegment[] {
    const segments: TextLinkSegment[] = [];
    const pattern = /(?:https?:\/\/|www\.)[^\s<>]+/giu;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
        const start = match.index;
        if (start && /[\p{L}\p{N}_@/:.-]/u.test(text[start - 1])) continue;
        const prefix = text.slice(0, start).match(/[^\s<>]*$/u)?.[0] ?? "";
        if (/^[a-z][a-z\d+.-]*:/iu.test(prefix)) continue;
        const source = trimEnd(match[0]);
        const href = /^www\./iu.test(source) ? `https://${source}` : source;
        let url: URL;
        try {
            url = new URL(href);
        } catch {
            continue;
        }
        if (!url.hostname) continue;
        if (start > cursor)
            segments.push({
                type: "text",
                text: text.slice(cursor, start),
                start: cursor,
            });
        const host = url.host.replace(/^www\./iu, "");
        const suffix = source.replace(/^(?:https?:\/\/)?[^/?#]+/iu, "");
        const short = host + suffix;
        segments.push({
            type: "link",
            text: source,
            start,
            href,
            label:
                short.length > labelLimit
                    ? `${host}${suffix.slice(0, Math.max(0, labelLimit - host.length - 1))}…`
                    : short,
        });
        cursor = start + source.length;
    }
    if (cursor < text.length)
        segments.push({
            type: "text",
            text: text.slice(cursor),
            start: cursor,
        });
    return segments;
}
