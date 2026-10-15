import type { ContentSegment } from "@/lib/content/types";

function validAt(value: Date | null | undefined): Date | null {
    return value && Number.isFinite(value.getTime()) ? value : null;
}

/** A quoted claim's date when valid and not later than the quoting item. */
export function plausibleQuotedStatementTime(
    itemOccurredAt: Date,
    claimedAt: Date | null | undefined,
): Date {
    const parsed = validAt(claimedAt);
    return parsed && parsed.getTime() <= itemOccurredAt.getTime()
        ? parsed
        : itemOccurredAt;
}

/** The statement time of evidence in one content segment. */
export function statementTimeForSegment(
    itemOccurredAt: Date,
    segment: ContentSegment | null | undefined,
): Date {
    if (segment?.role !== "quoted" && segment?.role !== "quoted_signature") {
        return itemOccurredAt;
    }
    return plausibleQuotedStatementTime(itemOccurredAt, segment.at);
}

/** Whether a statement may supersede the current value of one task field. */
export function fieldProposalIsLater(
    statementAt: Date,
    effectiveAt: Date | null | undefined,
): boolean {
    return !effectiveAt || statementAt.getTime() > effectiveAt.getTime();
}
