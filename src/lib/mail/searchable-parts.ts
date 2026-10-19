import type { ContentSegment } from "@/lib/content/types";

/** A searchable mail part with its claimed author reference. */
export interface SearchableMailPart {
    part: "body" | "quoted";
    participantRef: string | null;
    text: string;
}

/** Body and quoted text, excluding quotes whose originals the viewer can read. */
export function searchableMailParts(
    segments: readonly ContentSegment[],
    visibleOriginalIds: ReadonlySet<string>,
): SearchableMailPart[] {
    return segments.flatMap((segment) => {
        if (segment.role !== "body" && segment.role !== "quoted") return [];
        if (
            segment.role === "quoted" &&
            segment.knownItemId &&
            visibleOriginalIds.has(segment.knownItemId)
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
