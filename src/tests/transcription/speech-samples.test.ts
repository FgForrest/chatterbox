import { describe, expect, it } from "vitest";
import {
    compareSpeakingLabels,
    EVIDENCE_PLAY_LIMIT_MS,
    SAMPLE_MIN_DURATION_MS,
    SAMPLE_MIN_WORDS,
    SAMPLE_PLAY_LIMIT_MS,
    SAMPLE_PRE_ROLL_MS,
    SAMPLE_RANK_CAP_MS,
    STRETCH_GAP_MS,
    speakerEvidenceClip,
    speakerSpeechSamples,
    speakingStats,
    speechQuote,
    speechStretches,
} from "@/lib/transcript/speech-samples";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const words = (count = SAMPLE_MIN_WORDS) =>
    Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
const turn = (
    startMs: number,
    duration: number,
    speaker = "speaker_0",
    count = SAMPLE_MIN_WORDS,
): TranscriptTurn => ({
    speaker,
    startMs,
    endMs: startMs + duration,
    text: words(count),
});

describe("speech samples", () => {
    it("merges at the inclusive gap limit and counts words across turns", () => {
        const turns = [
            turn(0, 3000, "speaker_0", 6),
            turn(3000 + STRETCH_GAP_MS, 3000, "speaker_0", 6),
        ];
        expect(speechStretches(turns, "speaker_0")).toMatchObject([
            { startMs: 0, endMs: 7500, words: 12 },
        ]);
        expect(speakerSpeechSamples(turns, "speaker_0").fallback).toBe(false);
        expect(
            speechStretches(
                [turns[0], { ...turns[1], startMs: turns[1].startMs + 1 }],
                "speaker_0",
            ),
        ).toHaveLength(2);
    });
    it("does not merge across another label starting between turns, including overlap", () => {
        expect(
            speechStretches(
                [turn(0, 4000), turn(3000, 100, "speaker_1"), turn(4500, 4000)],
                "speaker_0",
            ),
        ).toHaveLength(2);
    });
    it.each([
        [SAMPLE_MIN_DURATION_MS, SAMPLE_MIN_WORDS, false],
        [SAMPLE_MIN_DURATION_MS - 1, SAMPLE_MIN_WORDS, true],
        [SAMPLE_MIN_DURATION_MS, SAMPLE_MIN_WORDS - 1, true],
    ])("checks duration %s and words %s at their edges", (duration, count, fallback) => {
        expect(
            speakerSpeechSamples(
                [turn(0, duration, "speaker_0", count)],
                "speaker_0",
            ).fallback,
        ).toBe(fallback);
    });
    it("accepts exactly 20 percent overlap and drops more; overlapping others count only once", () => {
        const main = turn(0, 10000);
        expect(
            speakerSpeechSamples(
                [
                    main,
                    turn(1000, 2000, "speaker_1"),
                    turn(1000, 2000, "speaker_2"),
                ],
                "speaker_0",
            ).fallback,
        ).toBe(false);
        expect(
            speakerSpeechSamples(
                [main, turn(1000, 2001, "speaker_1")],
                "speaker_0",
            ).fallback,
        ).toBe(true);
    });
    it("picks the best in each third, fills empty thirds, then presents time order", () => {
        const turns = [
            turn(0, 6000),
            turn(10000, 9000),
            turn(25000, 8000),
            turn(50000, 10000),
            turn(80000, 6000),
            turn(100000, 20000, "speaker_1"),
        ];
        expect(
            speakerSpeechSamples(turns, "speaker_0").samples.map(
                (s) => s.startMs,
            ),
        ).toEqual([10000, 50000, 80000]);
        expect(
            speakerSpeechSamples(
                turns.filter((t) => t.startMs !== 50000 && t.startMs !== 80000),
                "speaker_0",
            ).samples.map((s) => s.startMs),
        ).toEqual([0, 10000, 25000]);
    });
    it("assigns a stretch starting exactly on a third boundary to the later third", () => {
        const turns = [
            turn(0, 7000),
            turn(10000, 9000),
            turn(30000, 6000),
            turn(60000, 6000),
            turn(89000, 1000, "speaker_1"),
        ];
        expect(
            speakerSpeechSamples(turns, "speaker_0").samples.map(
                (s) => s.startMs,
            ),
        ).toEqual([10000, 30000, 60000]);
    });
    it("uses recording thirds despite an erroneous turn ending at 180 seconds", () => {
        const turns = [
            turn(0, 18000),
            turn(20000, 17000),
            turn(40000, 10000),
            turn(70000, 10000),
            turn(170000, 10000, "speaker_1"),
        ];
        expect(
            speakerSpeechSamples(turns, "speaker_0", 90000).samples.map(
                (sample) => sample.startMs,
            ),
        ).toEqual([0, 40000, 70000]);
        for (const unknown of [undefined, null, 0])
            expect(
                speakerSpeechSamples(turns, "speaker_0", unknown).samples.map(
                    (sample) => sample.startMs,
                ),
            ).toEqual([0, 20000, 70000]);
    });
    it("ignores turns outside the recording and clamps candidates, overlap and fallback", () => {
        const turns = [
            turn(85000, 95000),
            turn(90000, 5000),
            turn(180000, 10000, "speaker_1"),
        ];
        const result = speakerSpeechSamples(turns, "speaker_0", 90000);
        expect(result.fallback).toBe(true);
        expect(result.samples).toMatchObject([
            { startMs: 85000, endMs: 90000, untilMs: 90000 },
        ]);
        expect(result.longestTurnMs).toBe(5000);
        expect(result.longestStretchMs).toBe(5000);
        const full = speakerSpeechSamples(
            [turn(80000, 100000), turn(90000, 100000, "speaker_1")],
            "speaker_0",
            90000,
        );
        expect(full.fallback).toBe(false);
        expect(full.samples).toMatchObject([
            { startMs: 80000, endMs: 90000, overlap: 0, untilMs: 90000 },
        ]);
    });
    it("caps ranking at twenty seconds, then prefers less overlap, then earlier", () => {
        expect(SAMPLE_RANK_CAP_MS).toBe(20000);
        const turns = [
            turn(0, 22000),
            turn(1000, 2000, "speaker_1"),
            turn(30000, 21000),
            turn(60000, 20000),
            turn(90000, 21000),
            turn(400000, 1000, "speaker_1"),
        ];
        expect(
            speakerSpeechSamples(turns, "speaker_0").samples.map(
                (s) => s.startMs,
            ),
        ).toEqual([30000, 60000, 90000]);
    });
    it("pre-rolls without going negative and caps the real playback length", () => {
        expect(
            speakerSpeechSamples([turn(100, 7000)], "speaker_0").samples[0],
        ).toMatchObject({ ms: 0, untilMs: 7100 });
        const sample = speakerSpeechSamples([turn(1000, 30000)], "speaker_0")
            .samples[0];
        expect(sample.ms).toBe(1000 - SAMPLE_PRE_ROLL_MS);
        expect(sample.untilMs - sample.ms).toBe(SAMPLE_PLAY_LIMIT_MS);
        expect(
            speakerSpeechSamples([turn(1000, 6000)], "speaker_0").samples[0],
        ).toMatchObject({ ms: 700, untilMs: 7000 });
    });
    it("cuts a long turn at the latest stored sentence end and quotes only played sentences", () => {
        const timed = {
            ...turn(1000, 30000),
            text: "First sentence has enough words for a full listening sample. Second   sentence ends here! Third sentence continues. Fourth sentence finishes.",
            sentenceStartsMs: [1000, 7000, 11000, 14000],
        };
        const sample = speakerSpeechSamples([timed], "speaker_0").samples[0];
        expect(sample).toMatchObject({
            ms: 700,
            untilMs: 11000,
            text: "First sentence has enough words for a full listening sample. Second sentence ends here!",
        });
    });
    it("cuts at a merged turn end without stored sentence times", () => {
        const first = { ...turn(1000, 8000), text: `${words()}.` };
        const second = { ...turn(9500, 20000), text: "Unplayed words." };
        expect(
            speakerSpeechSamples([first, second], "speaker_0").samples[0],
        ).toMatchObject({ ms: 700, untilMs: 9000, text: first.text });
    });
    it("quotes preceding turns and the played sentences of a later merged turn", () => {
        const first = { ...turn(0, 7000), text: `${words()}.` };
        const second = {
            ...turn(7500, 20000),
            text: "This sentence plays. This one does not.",
            sentenceStartsMs: [7500, 10000],
        };
        expect(
            speakerSpeechSamples([first, second], "speaker_0").samples[0],
        ).toMatchObject({
            untilMs: 10000,
            text: `${first.text} This sentence plays.`,
        });
    });
    it.each([
        0, 1000,
    ])("ignores a stored boundary before the minimum with a turn starting at %s", (startMs) => {
        const timed = {
            ...turn(startMs, 30000),
            text: `${words()}. The rest continues.`,
            sentenceStartsMs: [
                startMs,
                Math.max(0, startMs - SAMPLE_PRE_ROLL_MS) +
                    SAMPLE_MIN_DURATION_MS -
                    1,
            ],
        };
        const sample = speakerSpeechSamples([timed], "speaker_0").samples[0];
        expect(sample.untilMs - sample.ms).toBe(SAMPLE_PLAY_LIMIT_MS);
        expect(sample.text).toBe(timed.text);
    });
    it.each([
        [0, SAMPLE_MIN_DURATION_MS],
        [0, SAMPLE_PLAY_LIMIT_MS],
        [1000, SAMPLE_MIN_DURATION_MS],
        [1000, SAMPLE_PLAY_LIMIT_MS],
    ])("accepts an exact boundary at %s plus pre-rolled duration %s", (startMs, duration) => {
        const ms = Math.max(0, startMs - SAMPLE_PRE_ROLL_MS);
        const timed = {
            ...turn(startMs, 30000),
            text: `${words()}. Unplayed sentence.`,
            sentenceStartsMs: [startMs, ms + duration],
        };
        expect(
            speakerSpeechSamples([timed], "speaker_0").samples[0],
        ).toMatchObject({
            ms,
            untilMs: ms + duration,
            text: `${words()}.`,
        });
    });
    it.each([
        [1000],
        [1000, 9000, 12000],
        [0, 9000],
        [1000, 32000],
        [1000, Number.NaN],
        [1000, Number.POSITIVE_INFINITY],
        [9000, 1000],
    ])("ignores invalid stored sentence times %j", (...sentenceStartsMs) => {
        const timed = {
            ...turn(1000, 30000),
            text: `${words()}. The rest continues.`,
            sentenceStartsMs,
        };
        expect(
            speakerSpeechSamples([timed], "speaker_0").samples[0],
        ).toMatchObject({ ms: 700, untilMs: 12700, text: timed.text });
    });
    it("does not interpolate sentence boundaries in legacy transcripts", () => {
        const legacy = {
            ...turn(0, 30000),
            text: `${words()}. ${words()}. ${words()}.`,
        };
        expect(
            speakerSpeechSamples([legacy], "speaker_0").samples[0],
        ).toMatchObject({ ms: 0, untilMs: 12000, text: legacy.text });
    });
    it("plays a fitting stretch to its end despite earlier exact boundaries", () => {
        const timed = {
            ...turn(0, 11000),
            text: `${words()}. Last sentence.`,
            sentenceStartsMs: [0, 7000],
        };
        expect(
            speakerSpeechSamples([timed], "speaker_0").samples[0],
        ).toMatchObject({ untilMs: 11000, text: timed.text });
    });
    it("orders sentence ends and merged turn ends while retaining sentence indexes", () => {
        const stretches = speechStretches(
            [
                {
                    ...turn(0, 10000),
                    text: "First sentence. Second sentence.",
                    sentenceStartsMs: [0, 9000],
                },
                {
                    ...turn(10500, 20000),
                    text: "Third sentence. Fourth sentence. Fifth sentence.",
                    sentenceStartsMs: [10500, 11000, 12000],
                },
            ],
            "speaker_0",
        );
        expect(stretches[0].boundaries).toEqual([
            { ms: 9000, sentenceIndex: 1 },
            { ms: 10000, sentenceIndex: 2 },
            { ms: 11000, sentenceIndex: 3 },
            { ms: 12000, sentenceIndex: 4 },
        ]);
    });
    it("cuts overlapping turns of one label at twelve seconds and quotes the whole stretch", () => {
        const long = {
            ...turn(0, 30000),
            text: "A first sentence with several words in it. A later sentence.",
            sentenceStartsMs: [0, 20000],
        };
        const inside = { ...turn(5000, 3000), text: "Inside." };
        const after = { ...turn(9000, 26000), text: `${words()}.` };
        const sample = speakerSpeechSamples([long, inside, after], "speaker_0")
            .samples[0];
        expect(sample).toMatchObject({
            ms: 0,
            untilMs: SAMPLE_PLAY_LIMIT_MS,
            boundaries: [],
            text: `${long.text} ${inside.text} ${after.text}`,
        });
    });
    it("keeps exact boundaries within recording bounds without inventing a cut at its end", () => {
        const timed = {
            ...turn(-1000, 31000),
            text: `${words()}. Second sentence. Third sentence.`,
            sentenceStartsMs: [0, 9000, 20000],
        };
        expect(
            speakerSpeechSamples([timed], "speaker_0", 15000).samples[0],
        ).toMatchObject({
            startMs: 0,
            endMs: 15000,
            untilMs: 9000,
            text: `${words()}.`,
            boundaries: [{ ms: 9000, sentenceIndex: 1 }],
        });
    });
    it("uses exact sentence ends for long fallback turns as well", () => {
        const timed = {
            ...turn(0, 30000),
            text: "Short sentence. Another sentence.",
            sentenceStartsMs: [0, 8000],
        };
        const result = speakerSpeechSamples([timed], "speaker_0");
        expect(result.fallback).toBe(true);
        expect(result.samples[0]).toMatchObject({
            untilMs: 8000,
            text: "Short sentence.",
        });
    });
    it("falls back to the three longest individual turns of at least one second", () => {
        const result = speakerSpeechSamples(
            [
                turn(0, 999),
                turn(10000, 1000),
                turn(20000, 4000),
                turn(30000, 2000),
                turn(40000, 3000),
            ],
            "speaker_0",
        );
        expect(result.fallback).toBe(true);
        expect(result.longestTurnMs).toBe(4000);
        expect(result.samples.map((s) => s.startMs)).toEqual([
            20000, 30000, 40000,
        ]);
        expect(
            speakerSpeechSamples([turn(0, 1000)], "speaker_0").samples,
        ).toHaveLength(1);
        expect(speakerSpeechSamples([turn(0, 999)], "speaker_0")).toMatchObject(
            { samples: [], fallback: true, longestTurnMs: 999 },
        );
    });
    it("handles empty input and missing labels without mutation", () => {
        expect(speakerSpeechSamples([], "speaker_0")).toEqual({
            samples: [],
            fallback: true,
            longestTurnMs: 0,
            longestStretchMs: 0,
        });
        const turns = Object.freeze([Object.freeze(turn(0, 7000))]);
        expect(speakerSpeechSamples(turns, "speaker_0").samples).toHaveLength(
            1,
        );
        expect(speakerSpeechSamples(turns, "speaker_1").samples).toEqual([]);
    });
});

it("sums speaking time, counts turns and orders ties by label number", () => {
    const turns = [
        turn(0, 3000, "speaker_10"),
        turn(3000, 3000, "speaker_2"),
        turn(6000, 2000),
        turn(8000, 4000),
    ];
    const stats = speakingStats(turns);
    expect(stats.get("speaker_0")).toEqual({ durationMs: 6000, replies: 2 });
    expect(
        ["speaker_10", "speaker_2", "speaker_0"].sort((a, b) =>
            compareSpeakingLabels(a, b, stats),
        ),
    ).toEqual(["speaker_0", "speaker_2", "speaker_10"]);
    expect(
        compareSpeakingLabels("S10", "speaker_2", new Map()),
    ).toBeGreaterThan(0);
});

it("skips placeholder labels while normalizing labels and counting non-positive turns", () => {
    const stats = speakingStats([
        turn(0, 1000, ""),
        turn(1000, 1000, "   "),
        turn(2000, 1000, "speaker"),
        turn(3000, 1000, " Speaker "),
        turn(4000, 3000, " speaker_0 "),
        turn(7000, 0, "speaker_0"),
        turn(7000, -1000, "speaker_0"),
        turn(8000, 2000, "speaker_2"),
    ]);
    expect([...stats]).toEqual([
        ["speaker_0", { durationMs: 3000, replies: 3 }],
        ["speaker_2", { durationMs: 2000, replies: 1 }],
    ]);
});

it("bounds evidence by its containing turn and fifteen seconds, including evidence inside a turn", () => {
    const turns = [turn(1000, 30000)];
    expect(speakerEvidenceClip(turns, 0)).toBeNull();
    expect(speakerEvidenceClip(turns, 2000)).toMatchObject({
        ms: 2000,
        untilMs: 2000 + EVIDENCE_PLAY_LIMIT_MS,
    });
    expect(speakerEvidenceClip(turns, 30000)).toMatchObject({
        ms: 30000,
        untilMs: 31000,
    });
    expect(speakerEvidenceClip(turns, 31000)).toBeNull();
});

it("centres evidence on the proposed name or first name and truncates sample quotes", () => {
    const text = `${"Earlier words. ".repeat(20)}Jitka Dvořáková can answer. ${"Later words. ".repeat(20)}`;
    expect(speechQuote(text, 60, "Jitka Dvořáková")).toContain(
        "Jitka Dvořáková",
    );
    expect(speechQuote(text, 60, "Jitka Nová")).toContain("Jitka");
    expect(speechQuote(text, 60, "Petr Malý")).toBe(`${text.slice(0, 60)}…`);
    expect(speechQuote("short")).toBe("short");
    expect(speechQuote(text)).toHaveLength(101);
});
