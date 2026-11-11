const CLOSING = { ")": "(", "]": "[", "}": "{" };
const LABEL_LIMIT = 48;

function trimUrl(value) {
    let end = value.length;
    while (end) {
        const last = value[end - 1];
        if (/[.,;:!?]/u.test(last)) {
            end--;
            continue;
        }
        const candidate = value.slice(0, end);
        const opening = CLOSING[last];
        if (
            opening &&
            candidate.split(last).length > candidate.split(opening).length
        ) {
            end--;
            continue;
        }
        if (last === "'" && candidate.split("'").length % 2 === 0) {
            end--;
            continue;
        }
        break;
    }
    return value.slice(0, end);
}

/** Split plain text into unchanged text and validated HTTP(S) links with compact labels. */
export function splitLinks(value) {
    const segments = [];
    let offset = 0;
    for (const match of value.matchAll(
        /(?:https?:\/\/|www\.)[^\s<>"`“”„«»‘’]+/giu,
    )) {
        if (match.index && /[\p{L}\p{N}_@./:-]/u.test(value[match.index - 1]))
            continue;
        const raw = trimUrl(match[0]);
        const href = /^www\./iu.test(raw) ? `https://${raw}` : raw;
        let url;
        try {
            url = new URL(href);
        } catch {
            continue;
        }
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
            continue;
        if (match.index > offset)
            segments.push({ text: value.slice(offset, match.index) });
        const label =
            url.host.replace(/^www\./iu, "") +
            (url.pathname === "/" ? "" : url.pathname) +
            url.search +
            url.hash;
        segments.push({
            text: raw,
            href,
            label:
                label.length > LABEL_LIMIT
                    ? `${label.slice(0, LABEL_LIMIT - 1)}…`
                    : label,
        });
        offset = match.index + raw.length;
    }
    if (offset < value.length) segments.push({ text: value.slice(offset) });
    return segments;
}

/** Render links using DOM text nodes without interpreting markup or changing stored text. */
export function renderLinkedText(container, value) {
    container.replaceChildren();
    for (const segment of splitLinks(value ?? "")) {
        if (!segment.href) {
            container.append(
                container.ownerDocument.createTextNode(segment.text),
            );
            continue;
        }
        const link = container.ownerDocument.createElement("a");
        link.textContent = segment.label;
        link.href = segment.href;
        link.title = segment.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.addEventListener("click", (event) => event.stopPropagation());
        container.append(link);
    }
    return container;
}
