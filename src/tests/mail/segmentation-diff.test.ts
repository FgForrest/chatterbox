import { describe, expect, it } from "vitest";
import type { ContentSegment } from "@/lib/content/types";
import { mailSegmentationDiff } from "@/lib/mail/segmentation-diff";

const body: ContentSegment = {
    index: 0,
    role: "body",
    depth: 0,
    participantRef: "p1",
    at: null,
    text: "Example signature",
};

describe("mail segmentation measurement", () => {
    it("leaves identical segmentation unchanged", () => {
        expect(mailSegmentationDiff([body], [{ ...body }])).toMatchObject({
            changed: false,
            bodyShrank: false,
            bodyEmptied: false,
            quotedPartChanged: false,
            newSignatures: [],
        });
    });
    it("counts a new signature and an emptied body", () => {
        expect(
            mailSegmentationDiff(
                [body],
                [{ ...body, role: "signature", signatureCue: "markup" }],
            ),
        ).toMatchObject({
            changed: true,
            bodyShrank: true,
            bodyEmptied: true,
            newSignatures: ["markup"],
        });
    });
    it("does not count a new cue on an existing signature as newly cut text", () => {
        expect(
            mailSegmentationDiff(
                [{ ...body, role: "signature" }],
                [{ ...body, role: "signature", signatureCue: "delimiter" }],
            ),
        ).toMatchObject({
            changed: true,
            newSignatures: [],
            bodyShrank: false,
        });
    });
    it("ignores index shifts when counting quoted changes", () => {
        const quote: ContentSegment = {
            ...body,
            index: 1,
            depth: 1,
            role: "quoted",
        };
        expect(
            mailSegmentationDiff(
                [body, quote],
                [
                    body,
                    {
                        ...body,
                        index: 1,
                        role: "signature",
                        signatureCue: "contact",
                    },
                    { ...quote, index: 2 },
                ],
            ).quotedPartChanged,
        ).toBe(false);
        expect(
            mailSegmentationDiff(
                [quote],
                [
                    {
                        ...quote,
                        role: "quoted_signature",
                        signatureCue: "footer",
                    },
                ],
            ),
        ).toMatchObject({ quotedPartChanged: true, newSignatures: ["footer"] });
    });
});
