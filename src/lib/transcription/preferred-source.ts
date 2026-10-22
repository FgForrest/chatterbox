/** Transcript sources read for summaries and titles, most preferred first. */
export const TRANSCRIPT_SOURCE_ORDER = ["riffado", "mixed", "plaud"] as const;

/** Prefer a provider transcript, then an edit, then the imported transcript. */
export function preferredTranscript<T extends { source: string }>(
    rows: readonly T[],
): T | undefined {
    for (const source of TRANSCRIPT_SOURCE_ORDER) {
        const row = rows.find((item) => item.source === source);
        if (row) return row;
    }
    return undefined;
}
