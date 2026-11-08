import { describe, expect, it } from "vitest";
import { renderTurnsForLlm, renderTurnsForPeople } from "@/lib/learn/render";
import { segmentsToTurns } from "@/lib/plaud/content";
import { cutTranscript } from "@/lib/recordings/cut-range";
import {
    buildTimeMarks,
    paragraphsOf,
    sentenceStarts,
} from "@/lib/topics/timeline";
import { parseTranscriptionResponse } from "@/lib/transcription/format";
import {
    paragraphsFromTimedSegments,
    type TranscriptTurn,
    turnsFromLabelledSegments,
    withTurnText,
} from "@/lib/transcription/turns";

const turn: TranscriptTurn = {
    speaker: "S1",
    startMs: 1000,
    endMs: 101000,
    text: "First. Second. Third.",
    sentenceStartsMs: [1000, 71000, 81000],
};

describe("sentence start timing", () => {
    it("uses stored times for the existing sentence split", () => {
        expect(sentenceStarts(turn)).toEqual([
            { at: 0, ms: 1000 },
            { at: 7, ms: 71000 },
            { at: 15, ms: 81000 },
        ]);
    });
    it("falls back to the old interpolation when the length differs", () => {
        expect(sentenceStarts({ ...turn, sentenceStartsMs: [1] })).toEqual(
            sentenceStarts({ ...turn, sentenceStartsMs: undefined }),
        );
    });
    it("clamps stored times to the turn", () => {
        expect(
            sentenceStarts({
                ...turn,
                sentenceStartsMs: [0, 200000, 200000],
            }).map((s) => s.ms),
        ).toEqual([1000, 101000, 101000]);
    });
    it.each([
        [[-1000, 200000, 200000]],
        [[1000, 71000, 2000]],
    ])("interpolates instead of trusting negative or decreasing stored times: %j", (sentenceStartsMs) => {
        expect(sentenceStarts({ ...turn, sentenceStartsMs })).toEqual(
            sentenceStarts({ ...turn, sentenceStartsMs: undefined }),
        );
    });
    it("interpolates only within a coarse segment", () => {
        const turns = turnsFromLabelledSegments([
            { speaker: "S", startMs: 0, endMs: 1000, text: "Hi." },
            { speaker: "S", startMs: 50000, endMs: 60000, text: "One. Two." },
        ]);
        expect(turns?.[0].sentenceStartsMs).toEqual([0, 50000, 55556]);
    });
    it("handles whitespace and a sentence spanning segment boundaries", () => {
        const turns = turnsFromLabelledSegments([
            { speaker: "S", startMs: 0, endMs: 1000, text: "  A thought " },
            {
                speaker: "S",
                startMs: 2000,
                endMs: 11000,
                text: " ends. Next.  ",
            },
        ]);
        expect(turns?.[0].text).toBe("A thought ends. Next.");
        expect(turns?.[0].sentenceStartsMs).toEqual([0, 6909]);
    });
    it("does not add timing when the only unit is the whole turn", () => {
        expect(
            paragraphsFromTimedSegments([
                { startMs: 0, endMs: 1000, text: "One. Two." },
            ])?.[0],
        ).not.toHaveProperty("sentenceStartsMs");
        expect(
            parseTranscriptionResponse({ text: "One. Two." }, "json"),
        ).not.toHaveProperty("turns");
    });
    it("prefers verbose word timings to segment interpolation", () => {
        const parsed = parseTranscriptionResponse(
            {
                text: "Hello. Again.",
                segments: [{ text: "Hello. Again.", start: 1, end: 10 }],
                words: [
                    { word: "Hello", start: 1, end: 2 },
                    { word: "Again", start: 8, end: 9 },
                ],
            },
            "verbose_json",
        );
        expect(parsed.turns?.[0].sentenceStartsMs).toEqual([1000, 8000]);
    });
    it("uses a single word time when the segment includes leading silence", () => {
        const parsed = parseTranscriptionResponse(
            {
                text: "Hello.",
                segments: [{ text: "Hello.", start: 0, end: 10 }],
                words: [{ word: "Hello", start: 3, end: 4 }],
            },
            "verbose_json",
        );
        expect(parsed.turns?.[0].sentenceStartsMs).toEqual([3000]);
    });
    it.each([
        undefined,
        [],
    ])("keeps flat text without turns for verbose segments=%j", (segments) => {
        const parsed = parseTranscriptionResponse(
            {
                text: "Hello. Again.",
                segments,
                words: [
                    { word: "Hello", start: 1, end: 2 },
                    { word: "Again", start: 8, end: 9 },
                ],
            },
            "verbose_json",
        );
        expect(parsed.text).toBe("Hello. Again.");
        expect(parsed.turns).toBeUndefined();
    });
    it("falls back to segment times when words cannot align", () => {
        const parsed = parseTranscriptionResponse(
            {
                text: "One. Two.",
                segments: [
                    { text: "One.", start: 0, end: 1 },
                    { text: "Two.", start: 1.2, end: 2 },
                ],
                words: [{ word: "Wrong", start: 0, end: 1 }],
            },
            "verbose_json",
        );
        expect(parsed.turns?.[0].sentenceStartsMs).toEqual([0, 1200]);
    });
    it("keeps Plaud segment times after merging and seconds normalization", () => {
        expect(
            segmentsToTurns(
                [
                    {
                        speaker: 1,
                        content: "First.",
                        start_time: 0,
                        end_time: 1,
                    },
                    {
                        speaker: 1,
                        content: "Second.",
                        start_time: 8,
                        end_time: 9,
                    },
                ],
                9000,
            )?.[0].sentenceStartsMs,
        ).toEqual([0, 8000]);
    });
    it("keeps Plaud sentence starts when segment ends are absent", () => {
        expect(
            segmentsToTurns([
                { speaker: 1, content: "First.", start_time: 1000 },
                { speaker: 1, content: "Second.", start_time: 8000 },
            ])?.[0].sentenceStartsMs,
        ).toEqual([1000, 8000]);
    });
    it("does not invent finer timing for untimed Plaud segments", () => {
        expect(
            segmentsToTurns([
                { speaker: 1, content: "First." },
                { speaker: 1, content: "Second." },
            ])?.[0],
        ).not.toHaveProperty("sentenceStartsMs");
    });
    it("uses stored times for topic marks, overriding character remapping", () => {
        expect(
            buildTimeMarks([turn], { toHeard: () => 0 }).map((mark) => mark.ms),
        ).toEqual([1000, 71000]);
    });
    it("places paragraph and topic boundaries by stored sentence times", () => {
        const { paragraphs, topicParagraphs } = paragraphsOf([turn], [81000]);
        expect(paragraphs.map((p) => p.startMs)).toEqual([1000, 71000, 81000]);
        expect(paragraphs[topicParagraphs[0]].charStart).toBe(15);
    });
    it("shifts and clamps sentence times during a cut", () => {
        const cut = cutTranscript([turn], { startMs: 11000, endMs: 91000 });
        expect(cut.turns[0].sentenceStartsMs).toEqual([0, 60000, 70000]);
        expect(turn.sentenceStartsMs).toEqual([1000, 71000, 81000]);
    });
    it("keeps times for a correction with the same sentence count", () => {
        expect(
            withTurnText(turn, "A longer first. Second. Third.")
                .sentenceStartsMs,
        ).toEqual(turn.sentenceStartsMs);
    });
    it("drops times when a correction changes the sentence count", () => {
        const correction = {
            turnIndex: 0,
            charStart: 0,
            charEnd: 6,
            heard: "First.",
            kind: "fix" as const,
            replacement: "First part",
            meaning: "First part",
        };
        for (const render of [renderTurnsForPeople, renderTurnsForLlm])
            expect(render([turn], [correction])[0]).not.toHaveProperty(
                "sentenceStartsMs",
            );
    });
});
