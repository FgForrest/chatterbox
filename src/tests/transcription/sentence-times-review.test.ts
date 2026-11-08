import { describe, expect, it } from "vitest";
import { parseTranscriptionResponse } from "@/lib/transcription/format";
import {
    timedWordsInText,
    turnsFromLabelledSegments,
    withSentenceTiming,
} from "@/lib/transcription/turns";

describe("sentence timing cross-review regressions", () => {
    const turn = {
        speaker: "S",
        startMs: 0,
        endMs: 10000,
        text: "Hello. Again.",
    };
    const hello = {
        charStart: 0,
        charEnd: 5,
        startMs: 1000,
        endMs: 2000,
        word: true,
    };

    it.each([
        undefined,
        Number.NaN,
    ])("omits timing when Again has no finite end (%s)", (endMs) => {
        const parsed = parseTranscriptionResponse(
            {
                text: turn.text,
                segments: [{ text: turn.text, start: 0, end: 10 }],
                words: [
                    { word: "Hello", start: 1, end: 2 },
                    { word: "Again", start: 8, end: endMs },
                ],
            },
            "verbose_json",
        );
        expect(parsed.turns?.[0]).not.toHaveProperty("sentenceStartsMs");
    });

    it("does not reuse Hello for the untimed Again sentence", () => {
        expect(withSentenceTiming(turn, [hello])).not.toHaveProperty(
            "sentenceStartsMs",
        );
    });

    it.each([
        [
            {
                charStart: 0,
                charEnd: 2,
                startMs: 1000,
                endMs: 2000,
                word: true,
            },
            {
                charStart: 3,
                charEnd: 8,
                startMs: 5000,
                endMs: 9000,
                word: true,
            },
        ],
        [
            {
                charStart: 0,
                charEnd: 5,
                startMs: 1000,
                endMs: 4000,
                word: true,
            },
            {
                charStart: 6,
                charEnd: 8,
                startMs: 8000,
                endMs: 9000,
                word: true,
            },
        ],
    ])("does not borrow a word across a sentence boundary (%j)", (...units) => {
        expect(
            withSentenceTiming({ ...turn, text: "A. B. C." }, units),
        ).not.toHaveProperty("sentenceStartsMs");
    });

    it("rejects the partial repeated-word list after segment assignment", () => {
        const parsed = parseTranscriptionResponse(
            {
                text: "Go. Go now.",
                segments: [{ text: "Go. Go now.", start: 0, end: 10 }],
                words: [
                    { word: "Go", start: -0.1, end: 0.5 },
                    { word: "Go", start: 8, end: 8.5 },
                    { word: "now", start: 9, end: 9.5 },
                ],
            },
            "verbose_json",
        );
        expect(parsed.turns?.[0]).not.toHaveProperty("sentenceStartsMs");
    });

    it("requires complete lexical alignment, including both ends and the middle", () => {
        const go = { text: "Go", startMs: 8000, endMs: 8500 };
        const now = { text: "now", startMs: 9000, endMs: 9500 };
        for (const text of [
            "Go. Go now.",
            "Go missing now.",
            "Go now. Missing.",
        ])
            expect(timedWordsInText(text, [go, now])).toBeUndefined();
    });

    it("accepts complete repeated words and attached or standalone punctuation", () => {
        for (const texts of [
            ["Go", "Go", "now"],
            ["Go.", "Go", "now."],
            ["Go", ".", "Go", "now", "."],
        ]) {
            const units = timedWordsInText(
                "Go. Go now.",
                texts.map((text, index) => ({
                    text,
                    startMs: index * 1000,
                    endMs: index * 1000 + 500,
                })),
            );
            expect(units?.map(({ charStart }) => charStart)).toEqual(
                texts.length === 5 ? [0, 2, 4, 7, 10] : [0, 4, 7],
            );
        }
    });

    it("omits timing for merged segments with a NaN final bound", () => {
        expect(
            turnsFromLabelledSegments([
                { speaker: "S", text: "One.", startMs: 0, endMs: 1000 },
                { speaker: "S", text: "Two.", startMs: 2000, endMs: 3000 },
                {
                    speaker: "S",
                    text: "Three.",
                    startMs: 4000,
                    endMs: Number.NaN,
                },
            ])?.[0],
        ).not.toHaveProperty("sentenceStartsMs");
    });

    it.each([
        [Number.NaN, 10000],
        [0, Number.NaN],
        [0, Number.POSITIVE_INFINITY],
        [10000, 0],
    ])("omits timing for invalid turn bounds [%s, %s]", (startMs, endMs) => {
        expect(
            withSentenceTiming({ ...turn, startMs, endMs }, [
                hello,
                {
                    charStart: 7,
                    charEnd: 12,
                    startMs: 8000,
                    endMs: 9000,
                    word: true,
                },
            ]),
        ).not.toHaveProperty("sentenceStartsMs");
    });

    it("visits 20000 words linearly when assigning them to 10000 segments", () => {
        const segments = Array.from({ length: 10000 }, (_, index) => ({
            text: "Word. Other.",
            start: index * 2,
            end: index * 2 + 1,
        }));
        const words = segments.flatMap((segment) => [
            { word: "Word", start: segment.start, end: segment.start + 0.2 },
            { word: "Other", start: segment.start + 0.7, end: segment.end },
        ]);
        let reads = 0;
        Object.defineProperty(words, "map", {
            value: function map<T>(
                callback: (
                    word: (typeof words)[number],
                    index: number,
                    array: typeof words,
                ) => T,
            ) {
                return new Proxy(
                    Array.prototype.map.call(words, callback) as T[],
                    {
                        get(target, property, receiver) {
                            if (
                                typeof property === "string" &&
                                /^\d+$/.test(property)
                            )
                                reads++;
                            return Reflect.get(target, property, receiver);
                        },
                    },
                );
            },
        });
        const parsed = parseTranscriptionResponse(
            { text: "", segments, words },
            "verbose_json",
        );
        expect(parsed.turns).toHaveLength(625);
        expect(parsed.turns?.at(-1)?.sentenceStartsMs?.slice(-2)).toEqual([
            19998000, 19998700,
        ]);
        expect(reads).toBeLessThanOrEqual(
            10 * (words.length + segments.length),
        );
    });
});
