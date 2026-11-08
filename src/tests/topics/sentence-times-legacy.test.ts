import { describe, expect, it } from "vitest";
import {
    buildTimeMarks,
    paragraphsOf,
    sentenceStarts,
} from "@/lib/topics/timeline";

describe("sentence timing compatibility with origin/dev", () => {
    it.each(
        [undefined, [1], [Number.NaN, 1]].map((sentenceStartsMs) => ({
            sentenceStartsMs,
        })),
    )("preserves character-distance topic placement with leading whitespace (%j)", ({
        sentenceStartsMs,
    }) => {
        const turn = {
            speaker: "S",
            startMs: 0,
            endMs: 120000,
            text: "          A. B.",
            sentenceStartsMs,
        };
        expect(sentenceStarts(turn)).toEqual([
            { at: 10, ms: 0 },
            { at: 13, ms: 104000 },
        ]);
        expect(paragraphsOf([turn], [60000])).toEqual({
            paragraphs: [
                { turnIndex: 0, charStart: 0, startMs: 0 },
                { turnIndex: 0, charStart: 13, startMs: 104000 },
            ],
            topicParagraphs: [0],
        });
        expect(buildTimeMarks([turn])).toEqual([
            { ms: 0, turnIndex: 0, speaker: "S", text: "A." },
            { ms: 104000, turnIndex: 0, speaker: null, text: "B." },
        ]);
    });

    it.each(
        [undefined, [1], [0, Number.NaN, 2]].map((sentenceStartsMs) => ({
            sentenceStartsMs,
        })),
    )("preserves character-distance topic placement at the rounding boundary (%j)", ({
        sentenceStartsMs,
    }) => {
        const turn = {
            speaker: "S",
            startMs: 0,
            endMs: 60001,
            text: "a. bbbb. C.",
            sentenceStartsMs,
        };
        expect(sentenceStarts(turn)).toEqual([
            { at: 0, ms: 0 },
            { at: 3, ms: 16364 },
            { at: 9, ms: 49092 },
        ]);
        expect(paragraphsOf([turn], [8182])).toEqual({
            paragraphs: [
                { turnIndex: 0, charStart: 0, startMs: 0 },
                { turnIndex: 0, charStart: 3, startMs: 16364 },
                { turnIndex: 0, charStart: 9, startMs: 49092 },
            ],
            topicParagraphs: [1],
        });
        expect(buildTimeMarks([turn])).toEqual([
            { ms: 0, turnIndex: 0, speaker: "S", text: "a." },
            { ms: 16364, turnIndex: 0, speaker: null, text: "bbbb." },
            { ms: 49092, turnIndex: 0, speaker: null, text: "C." },
        ]);
        expect(
            buildTimeMarks([turn], {
                toHeard: (_index, fraction) => fraction / 2,
            }),
        ).toEqual([
            { ms: 0, turnIndex: 0, speaker: "S", text: "a. bbbb." },
            { ms: 24546, turnIndex: 0, speaker: null, text: "C." },
        ]);
    });

    it("selects topics by milliseconds when stored timing is valid", () => {
        expect(
            paragraphsOf(
                [
                    {
                        speaker: "S",
                        startMs: 0,
                        endMs: 120000,
                        text: "          A. B.",
                        sentenceStartsMs: [0, 104000],
                    },
                ],
                [60000],
            ).topicParagraphs,
        ).toEqual([1]);
    });
});
