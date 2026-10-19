import { describe, expect, it } from "vitest";
import type { ContentSegment, SegmentRole } from "@/lib/content/types";
import { searchableMailParts } from "@/lib/mail/searchable-parts";

function segment(
    role: SegmentRole,
    index: number,
    knownItemId: string | null = null,
): ContentSegment {
    return {
        index,
        role,
        participantRef: `p${index + 1}`,
        depth: role.startsWith("quoted") ? 1 : 0,
        at: null,
        text: `${role} ${index}`,
        knownItemId,
    };
}

describe("searchable mail parts", () => {
    it("selects body and quoted text in order, retaining labels and authors", () => {
        const segments = [
            segment("body", 0),
            segment("signature", 1),
            segment("quoted", 2),
            segment("quoted_signature", 3),
            segment("disclaimer", 4),
            segment("spoken", 5),
            { ...segment("quoted", 6), participantRef: null, depth: 2 },
        ];
        expect(searchableMailParts(segments, new Set())).toEqual([
            { part: "body", participantRef: "p1", text: "body 0" },
            { part: "quoted", participantRef: "p3", text: "quoted 2" },
            { part: "quoted", participantRef: null, text: "quoted 6" },
        ]);
    });

    it("skips a known quote only when its original is visible", () => {
        const segments = [
            segment("body", 0, "visible"),
            segment("quoted", 1, "visible"),
            segment("quoted", 2, "private"),
            segment("quoted", 3, "deleted"),
            segment("quoted", 4),
        ];
        expect(searchableMailParts(segments, new Set(["visible"]))).toEqual([
            { part: "body", participantRef: "p1", text: "body 0" },
            { part: "quoted", participantRef: "p3", text: "quoted 2" },
            { part: "quoted", participantRef: "p4", text: "quoted 3" },
            { part: "quoted", participantRef: "p5", text: "quoted 4" },
        ]);
        expect(searchableMailParts(segments, new Set())).toHaveLength(5);
    });
});
