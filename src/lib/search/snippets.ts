const BOUNDARY_EXTENSION = 30;

function atBoundary(text: string, index: number): boolean {
    return (
        index <= 0 ||
        index >= text.length ||
        /\s/u.test(text[index - 1]) ||
        /\s/u.test(text[index])
    );
}

/**
 * `[from, to)` snapped to whitespace or the text's edges: widened by at
 * most 30 characters per side, else narrowed without cutting into `keep`,
 * else left cut mid-word.
 */
export function snippetBounds(
    text: string,
    from: number,
    to: number,
    keep: { start: number; end: number },
): { start: number; end: number } {
    const rawStart = Math.max(0, Math.floor(from));
    const rawEnd = Math.min(text.length, Math.ceil(to));
    let start = rawStart;
    while (start > rawStart - BOUNDARY_EXTENSION && !atBoundary(text, start))
        start--;
    if (!atBoundary(text, start)) {
        start = rawStart;
        while (start < keep.start && !atBoundary(text, start)) start++;
        if (!atBoundary(text, start)) start = rawStart;
    }
    let end = rawEnd;
    while (end < rawEnd + BOUNDARY_EXTENSION && !atBoundary(text, end)) end++;
    if (!atBoundary(text, end)) {
        end = rawEnd;
        while (end > keep.end && !atBoundary(text, end)) end--;
        if (!atBoundary(text, end)) end = rawEnd;
    }
    return { start, end };
}
