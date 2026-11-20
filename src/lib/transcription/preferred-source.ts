/** Transcript sources read for summaries and titles, most preferred first. */
export const TRANSCRIPT_SOURCE_ORDER = ["riffado", "plaud"] as const;

/** Prefer a provider transcript over the imported transcript. */
export function preferredTranscript<T extends { source: string }>(
    rows: readonly T[],
): T | undefined {
    for (const source of TRANSCRIPT_SOURCE_ORDER) {
        const row = rows.find((item) => item.source === source);
        if (row) return row;
    }
    return undefined;
}

/** Use the Learn step's source when present, otherwise prefer a supported transcript. */
export function preferredLearnTranscript<T extends { source: string }>(
    rows: readonly T[],
    stepSource?: string,
): T | undefined {
    if (stepSource === "riffado" || stepSource === "plaud") {
        const selected = rows.find(({ source }) => source === stepSource);
        if (selected) return selected;
    }
    return preferredTranscript(rows);
}
