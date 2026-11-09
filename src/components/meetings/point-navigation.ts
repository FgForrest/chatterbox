/** Top offsets of the first visual line, the caret's line and the last visual line of a textarea. */
export interface CaretLines {
    firstTop: number;
    caretTop: number;
    lastTop: number;
}

/** Measure visual caret lines with the textarea's text layout, or one line without layout. */
export function measureCaretLines(input: HTMLTextAreaElement): CaretLines {
    const singleLine = { firstTop: 0, caretTop: 0, lastTop: 0 };
    if (!input.clientWidth) return singleLine;
    const style = getComputedStyle(input);
    const mirror = document.createElement("div");
    for (const property of [
        "width",
        "box-sizing",
        "font",
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "font-variant",
        "line-height",
        "padding",
        "border-width",
        "border-style",
        "letter-spacing",
        "word-spacing",
        "text-indent",
        "text-transform",
        "tab-size",
        "word-break",
        "overflow-wrap",
    ])
        mirror.style.setProperty(property, style.getPropertyValue(property));
    mirror.style.width = `${input.clientWidth}px`;
    mirror.style.boxSizing = "border-box";
    mirror.style.border = "0";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.left = "-10000px";
    mirror.setAttribute("aria-hidden", "true");
    document.body.append(mirror);
    try {
        const topAt = (position: number) => {
            const marker = document.createElement("span");
            marker.textContent = input.value.slice(position) || "\u200b";
            mirror.replaceChildren(
                document.createTextNode(input.value.slice(0, position)),
                marker,
            );
            return marker.getClientRects()[0]?.top;
        };
        const firstTop = topAt(0);
        const caretTop = topAt(input.selectionStart);
        const lastTop = topAt(input.value.length);
        return firstTop === undefined ||
            caretTop === undefined ||
            lastTop === undefined
            ? singleLine
            : { firstTop, caretTop, lastTop };
    } finally {
        mirror.remove();
    }
}

/** Decide whether a plain arrow at a visual boundary should leave the current point. */
export function pointArrowDirection(
    event: {
        key: string;
        altKey: boolean;
        ctrlKey: boolean;
        metaKey: boolean;
        shiftKey: boolean;
        isComposing: boolean;
        selectionStart: number | null;
        selectionEnd: number | null;
    },
    lines: CaretLines,
): -1 | 1 | null {
    if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.selectionStart !== event.selectionEnd
    )
        return null;
    if (
        event.key === "ArrowUp" &&
        Math.abs(lines.caretTop - lines.firstTop) < 1
    )
        return -1;
    if (
        event.key === "ArrowDown" &&
        Math.abs(lines.caretTop - lines.lastTop) < 1
    )
        return 1;
    return null;
}
