/**
 * Where in the audio a task was agreed: the turn its quote came from.
 * Pure. Models copy quotes loosely, so a turn holding most of the quote's
 * words counts when none holds it whole.
 */

interface QuoteTurn {
    startMs: number;
    text: string;
}

function words(text: string): string[] {
    return text
        .toLocaleLowerCase()
        .normalize("NFC")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/** Below this share of the quote's words in one turn, the quote is not placed. */
const MIN_OVERLAP = 0.6;

/** The start of the turn a quote was taken from, or null when none fits. */
export function locateQuote(
    turns: readonly QuoteTurn[] | null | undefined,
    quote: string | null | undefined,
): number | null {
    if (!turns?.length || !quote) return null;
    const wanted = words(quote);
    if (wanted.length === 0) return null;
    const phrase = wanted.join(" ");
    let best: { startMs: number; share: number } | null = null;
    for (const turn of turns) {
        const turnWords = words(turn.text);
        if (turnWords.join(" ").includes(phrase)) return turn.startMs;
        const present = new Set(turnWords);
        const share =
            wanted.filter((word) => present.has(word)).length / wanted.length;
        if (share >= MIN_OVERLAP && (!best || share > best.share)) {
            best = { startMs: turn.startMs, share };
        }
    }
    return best?.startMs ?? null;
}

/**
 * A task's text as compared for "the same task": case, punctuation, speaker
 * references and spacing folded away.
 */
export function normalizeTaskText(text: string): string {
    return words(
        text.replace(/\[Speaker (\d+)\]\(#speaker-\1\)/g, "speaker $1"),
    ).join(" ");
}
