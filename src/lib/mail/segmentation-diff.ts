import type { ContentSegment } from "@/lib/content/types";

function shape(segments: readonly ContentSegment[]) {
    return segments.map((segment) => ({
        index: segment.index,
        role: segment.role,
        participantRef: segment.participantRef,
        depth: segment.depth,
        at: segment.at ? new Date(segment.at).toISOString() : null,
        text: segment.text,
        signatureCue: segment.signatureCue ?? null,
        knownItemId: segment.knownItemId ?? null,
    }));
}

function quotedShape(segments: readonly ContentSegment[]): string {
    return JSON.stringify(
        shape(segments.filter((segment) => segment.depth > 0)).map(
            ({ index: _index, ...part }) => part,
        ),
    );
}

/** Counts the substantive and signature changes between stored and current segmentation. */
export function mailSegmentationDiff(
    before: readonly ContentSegment[],
    after: readonly ContentSegment[],
) {
    const bodySize = (segments: readonly ContentSegment[]) =>
        segments
            .filter((segment) => segment.role === "body")
            .reduce((size, segment) => size + segment.text.length, 0);
    const beforeSize = bodySize(before);
    const afterSize = bodySize(after);
    return {
        changed: JSON.stringify(shape(before)) !== JSON.stringify(shape(after)),
        newSignatures: after
            .filter(
                (segment) =>
                    (segment.role === "signature" ||
                        segment.role === "quoted_signature") &&
                    !before.some(
                        (old) =>
                            old.role === segment.role &&
                            old.depth === segment.depth &&
                            old.text === segment.text,
                    ),
            )
            .map((segment) => segment.signatureCue),
        bodyShrank: afterSize < beforeSize,
        bodyEmptied: beforeSize > 0 && afterSize === 0,
        quotedPartChanged: quotedShape(before) !== quotedShape(after),
    };
}
