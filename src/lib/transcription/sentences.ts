const SENTENCE_BREAK = /(?<=[.!?…]["'”»)\]]*)\s+/u;

/**
 * A turn's sentences, each with where it starts in the text as it is, and
 * its whitespace tidied for showing.
 */
export function sentencesOf(raw: string): { text: string; at: number }[] {
    const end = raw.trimEnd().length;
    let at = raw.length - raw.trimStart().length;
    const sentences: { text: string; at: number }[] = [];
    const breaks = new RegExp(SENTENCE_BREAK.source, "gu");
    for (const found of raw.slice(0, end).matchAll(breaks)) {
        if (found.index < at) continue;
        sentences.push({
            text: raw.slice(at, found.index).replace(/\s+/g, " "),
            at,
        });
        at = found.index + found[0].length;
    }
    sentences.push({ text: raw.slice(at, end).replace(/\s+/g, " "), at });
    return sentences;
}

/**
 * Accept only finite, non-negative, non-decreasing sentence times aligned
 * with the current sentence split.
 */
export function validSentenceStarts(
    text: string,
    value: unknown,
): number[] | undefined {
    return Array.isArray(value) &&
        value.length === sentencesOf(text).length &&
        value.every(
            (ms, index) =>
                typeof ms === "number" &&
                Number.isFinite(ms) &&
                ms >= 0 &&
                (index === 0 || ms >= value[index - 1]),
        )
        ? value
        : undefined;
}
