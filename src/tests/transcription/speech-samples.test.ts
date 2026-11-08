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
        expect(
            speakerSpeechSamples([turn(0, 999)], "speaker_0").samples,
        ).toEqual([]);
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
