import type { ContentSegment } from "@/lib/content/types";

/** A searchable mail part with its claimed author reference. */
export interface SearchableMailPart {
    part: "body" | "quoted";
    participantRef: string | null;
    text: string;
}

/**
 * Body and quoted text, excluding quotes whose originals are candidates
 * of the same search (whatever its continuation cursor).
 */
export function searchableMailParts(
    segments: readonly ContentSegment[],
    candidateOriginalIds: ReadonlySet<string>,
): SearchableMailPart[] {
    return segments.flatMap((segment) => {
        if (segment.role !== "body" && segment.role !== "quoted") return [];
        if (
            segment.role === "quoted" &&
            segment.knownItemId &&
            candidateOriginalIds.has(segment.knownItemId)
        ) {
            return [];
        }
        return [
            {
                part: segment.role,
                participantRef: segment.participantRef,
                text: segment.text,
            },
        ];
    });
}
