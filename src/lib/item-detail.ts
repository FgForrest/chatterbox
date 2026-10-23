export interface ItemDetailOptions {
    view?: "private" | "org" | "received";
    playFrom?: number | string;
    evidenceSegment?: number | string;
    evidenceStart?: number | string;
    evidenceEnd?: number | string;
}

/** Build the dashboard URL that opens an audio or mail item. */
export function itemDetailHref(
    id: string,
    options: ItemDetailOptions = {},
): string {
    const query = new URLSearchParams({ recording: id });
    if (options.view && options.view !== "private")
        query.set("view", options.view);
    for (const key of [
        "playFrom",
        "evidenceSegment",
        "evidenceStart",
        "evidenceEnd",
    ] as const) {
        const value = options[key];
        if (value !== undefined) query.set(key, String(value));
    }
    return `/dashboard?${query.toString()}`;
}
