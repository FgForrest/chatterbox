import { describe, expect, it } from "vitest";
import { anchorMatches } from "@/lib/knowledge/correction-anchors";
import {
    correctedTimeline,
    flattenTurns,
    type OverlayCorrection,
    renderTurnsForLlm,
    renderTurnsForPeople,
} from "@/lib/learn/render";
import { buildTimeMarks } from "@/lib/topics/timeline";

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5_000,
        text: "Welcome, Tavesy joined us. Tavesy!",
    },
    {
        speaker: "speaker_1",
        startMs: 5_000,
        endMs: 9_000,
        text: "Great, Honza, let us start.",
    },
];

const correct = (
    turnIndex: number,
    charStart: number,
    heard: string,
    replacement: string,
): OverlayCorrection => ({
    turnIndex,
    charStart,
    charEnd: charStart + heard.length,
    heard,
    kind: "correct",
    replacement,
    meaning: replacement,
});

const link = (
    turnIndex: number,
    charStart: number,
    heard: string,
    meaning: string,
): OverlayCorrection => ({
    turnIndex,
    charStart,
    charEnd: charStart + heard.length,
    heard,
    kind: "link",
    replacement: null,
    meaning,
});

describe("renderings", () => {
    const corrections = [
        correct(0, 9, "Tavesy", "Tavesi"),
        correct(0, 27, "Tavesy", "Tavesi"),
        link(1, 7, "Honza", "Jan Novotný"),
    ];

    it("for people: replacements applied, a link kept as spoken with its meaning", () => {
        const rendered = renderTurnsForPeople(TURNS, corrections);
        expect(rendered.map((turn) => turn.text)).toEqual([
            "Welcome, Tavesi joined us. Tavesi!",
            "Great, Honza, let us start.",
        ]);
        expect(rendered[1]?.segments).toEqual([
            { text: "Great, " },
            {
                text: "Honza",
                correction: {
                    kind: "link",
                    heard: "Honza",
                    meaning: "Jan Novotný",
                },
            },
            { text: ", let us start." },
        ]);
        expect(rendered[0]?.segments[1]).toEqual({
            text: "Tavesi",
            correction: { kind: "correct", heard: "Tavesy", meaning: "Tavesi" },
        });
        // Times and speakers as they were.
        expect(rendered[1]).toMatchObject({
            speaker: "speaker_1",
            startMs: 5_000,
            endMs: 9_000,
        });
    });

    it("for the model: replacements applied, a link written with its meaning, labels kept", () => {
        expect(renderTurnsForLlm(TURNS, corrections)).toEqual([
            { ...TURNS[0], text: "Welcome, Tavesi joined us. Tavesi!" },
            {
                ...TURNS[1],
                text: "Great, Honza [= Jan Novotný], let us start.",
            },
        ]);
    });

    it("leaves out a correction whose words are no longer there, or that overlaps one before it", () => {
        const rendered = renderTurnsForLlm(TURNS, [
            correct(0, 9, "Tavesy", "Tavesi"),
            // Overlaps the one above.
            correct(0, 12, "esy jo", "x"),
            // Not what the text says there.
            correct(1, 0, "Grate", "Great"),
            // Beyond the turns.
            correct(5, 0, "Hi", "Hello"),
        ]);
        expect(rendered.map((turn) => turn.text)).toEqual([
            "Welcome, Tavesi joined us. Tavesy!",
            "Great, Honza, let us start.",
        ]);
    });

    it("flattens turns the way the transcript is stored", () => {
        expect(flattenTurns(renderTurnsForLlm(TURNS, corrections))).toBe(
            "speaker_0: Welcome, Tavesi joined us. Tavesi!\nspeaker_1: Great, Honza [= Jan Novotný], let us start.",
        );
    });

    it("changes nothing without corrections", () => {
        expect(renderTurnsForLlm(TURNS, [])).toEqual(TURNS);
        expect(
            renderTurnsForPeople(TURNS, []).map((turn) => turn.segments),
        ).toEqual([[{ text: TURNS[0]?.text }], [{ text: TURNS[1]?.text }]]);
    });
});

describe("the corrected timeline", () => {
    it("keeps a long turn's inner marks where the audio has them", () => {
        const heard =
            "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa said this first. Then a second sentence of about equal length. And a third one closes it now.";
        const stored = [
            { speaker: "speaker_0", startMs: 0, endMs: 120_000, text: heard },
        ];
        const corrections: OverlayCorrection[] = [
            {
                turnIndex: 0,
                charStart: 0,
                charEnd: 30,
                heard: heard.slice(0, 30),
                kind: "correct",
                replacement: "B",
                meaning: "B",
            },
        ];
        const corrected = renderTurnsForLlm(stored, corrections);
        const asHeard = buildTimeMarks(stored).map((mark) => mark.ms);
        const read = buildTimeMarks(corrected, {
            toHeard: correctedTimeline(stored, corrections),
        });
        expect(read.map((mark) => mark.ms)).toEqual(asHeard);
        expect(read[0]?.text).toContain("B said this first.");
    });

    it("maps nothing where nothing was corrected", () => {
        const toHeard = correctedTimeline(TURNS, []);
        expect(toHeard(0, 0.5)).toBe(0.5);
    });
});

describe("anchors", () => {
    it("never split a character written as two UTF-16 units", () => {
        const turns = [
            { speaker: "speaker_0", startMs: 0, endMs: 1_000, text: "A😀B" },
        ];
        const at = (charStart: number, charEnd: number) =>
            anchorMatches(
                {
                    turnIndex: 0,
                    charStart,
                    charEnd,
                    heard: "A😀B".slice(charStart, charEnd),
                },
                turns,
            );
        expect(at(1, 2)).toBe(false);
        expect(at(2, 4)).toBe(false);
        expect(at(1, 3)).toBe(true);
        expect(
            renderTurnsForLlm(turns, [
                {
                    turnIndex: 0,
                    charStart: 1,
                    charEnd: 2,
                    heard: "\ud83d",
                    kind: "correct",
                    replacement: "X",
                    meaning: "X",
                },
            ])[0]?.text,
        ).toBe("A😀B");
    });
});

describe("overlapping corrections", () => {
    it("keep the one given first, even when another starts earlier", () => {
        const turns = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 1_000,
                text: "máme tu Tavesy dnes",
            },
        ];
        const confirmed = correct(0, 8, "Tavesy", "Tavesi");
        const pending = correct(0, 5, "tu Tavesy", "u Tavesiů");
        expect(renderTurnsForLlm(turns, [confirmed, pending])[0]?.text).toBe(
            "máme tu Tavesi dnes",
        );
    });
});
