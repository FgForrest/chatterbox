interface ReviewItem {
    kind: string;
    payload: unknown;
}

/** Rows added for coverage are optional and never create review work. */
export function isUnmentionedSpeaker(item: ReviewItem): boolean {
    return (
        item.kind === "speaker" &&
        item.payload !== null &&
        typeof item.payload === "object" &&
        "unmentioned" in item.payload &&
        item.payload.unmentioned === true
    );
}

/** Known facts apply automatically; optional speaker rows never hold processing. */
export function needsLearnReview(item: ReviewItem): boolean {
    return item.kind !== "known_fact" && !isUnmentionedSpeaker(item);
}

/** An unanswered no-name row is deferred, rather than remembered as a rejection. */
export function isUnansweredSpeaker(
    item: ReviewItem & { choice?: unknown },
): boolean {
    if (item.kind !== "speaker" || item.choice) return false;
    const payload = item.payload;
    return (
        payload !== null &&
        typeof payload === "object" &&
        "personId" in payload &&
        !payload.personId &&
        !("newRef" in payload && payload.newRef)
    );
}
