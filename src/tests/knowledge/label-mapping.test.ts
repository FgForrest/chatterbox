import { describe, expect, it } from "vitest";
import { mapLabels } from "@/lib/knowledge/label-mapping";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const t = (
    speaker: string,
    startMs: number,
    endMs: number,
): TranscriptTurn => ({ speaker, startMs, endMs, text: "x" });

describe("mapLabels", () => {
    it("carries renumbered speakers whose speech lines up", () => {
        const m = mapLabels(
            [t("speaker_0", 0, 10_000), t("speaker_1", 10_000, 20_000)],
            [t("speaker_1", 200, 9_800), t("speaker_0", 10_300, 20_000)],
        );
        expect(m.carried).toEqual(
            new Map([
                ["speaker_0", "speaker_1"],
                ["speaker_1", "speaker_0"],
            ]),
        );
        expect(m.uncertain.size).toBe(0);
    });

    it("only suggests for a speaker the new run split in two", () => {
        const m = mapLabels(
            [t("speaker_0", 0, 20_000)],
            [t("speaker_0", 0, 10_000), t("speaker_1", 10_000, 20_000)],
        );
        expect(m.carried.size).toBe(0);
        expect(m.uncertain).toEqual(new Map([["speaker_0", "speaker_0"]]));
    });

    it("suggests one old speaker, and carries none, into a 50/50 merge", () => {
        const m = mapLabels(
            [t("speaker_0", 0, 10_000), t("speaker_1", 10_000, 20_000)],
            [t("speaker_0", 0, 20_000)],
        );
        expect(m.carried.size).toBe(0);
        expect(m.uncertain).toEqual(new Map([["speaker_0", "speaker_0"]]));
    });

    it("does not carry the larger speaker into a 70/30 merge", () => {
        const m = mapLabels(
            [t("A", 0, 30_000), t("B", 30_000, 100_000)],
            [t("X", 0, 100_000)],
        );
        expect(m.carried.size).toBe(0);
        expect(m.uncertain).toEqual(new Map([["B", "X"]]));
    });

    it("does not carry a short speaker into a label that is mostly someone else", () => {
        const m = mapLabels(
            [t("A", 0, 10_000), t("B", 10_000, 110_000)],
            [t("X", 2_500, 50_000), t("Y", 50_000, 110_000)],
        );
        expect(m.carried.size).toBe(0);
        expect(m.uncertain).toEqual(
            new Map([
                ["B", "Y"],
                ["A", "X"],
            ]),
        );
    });

    it("assigns uncertain pairs by shared time, not by name", () => {
        // A overlaps X only slightly, B mostly; B must win X.
        const m = mapLabels(
            [t("A", 0, 1_000), t("B", 1_000, 70_000)],
            [t("X", 0, 100_000)],
        );
        expect(m.uncertain).toEqual(new Map([["B", "X"]]));
    });

    it("handles a speaker talking over another", () => {
        const m = mapLabels(
            [t("A", 0, 100_000), t("B", 40_000, 50_000)],
            [
                t("X", 0, 40_000),
                t("Y", 40_000, 50_000),
                t("X", 50_000, 100_000),
            ],
        );
        expect(m.carried).toEqual(new Map([["A", "X"]]));
        expect(m.uncertain).toEqual(new Map([["B", "Y"]]));
    });

    it("measures a label's speech as the union of its turns", () => {
        const m = mapLabels(
            [t("A", 0, 10_000), t("A", 5_000, 15_000)],
            [t("X", 0, 15_000)],
        );
        expect(m.carried.get("A")).toBe("X");
    });

    it("ignores placeholder labels", () => {
        const m = mapLabels(
            [t("", 0, 5_000), t("speaker", 5_000, 9_000)],
            [t("", 0, 9_000)],
        );
        expect(m.carried.size + m.uncertain.size).toBe(0);
    });

    it("pairs labels without timings by speaking order, as suggestions", () => {
        const m = mapLabels(
            [t("speaker_0", 0, 0), t("speaker_1", 5_000, 5_000)],
            [t("speaker_1", 0, 0), t("speaker_0", 5_000, 5_000)],
        );
        expect(m.carried.size).toBe(0);
        expect(m.uncertain).toEqual(
            new Map([
                ["speaker_0", "speaker_1"],
                ["speaker_1", "speaker_0"],
            ]),
        );
    });

    it("still pairs untimed labels when other labels are timed", () => {
        const m = mapLabels(
            [t("A", 0, 10_000), t("B", 20_000, 20_000)],
            [t("X", 0, 10_000), t("Y", 20_000, 20_000)],
        );
        expect(m.carried).toEqual(new Map([["A", "X"]]));
        expect(m.uncertain).toEqual(new Map([["B", "Y"]]));
    });

    it("pairs timed labels by order when the new transcript has no timings", () => {
        const m = mapLabels([t("A", 0, 10_000), t("B", 10_000, 20_000)], null, {
            nextLabels: ["X", "Y"],
        });
        expect(m.carried.size).toBe(0);
        expect(m.uncertain).toEqual(
            new Map([
                ["A", "X"],
                ["B", "Y"],
            ]),
        );
    });

    it("compares labels as keys", () => {
        const m = mapLabels(
            [t("speaker_0 ", 0, 10_000)],
            [t(" speaker_1", 0, 10_000)],
        );
        expect(m.carried).toEqual(new Map([["speaker_0", "speaker_1"]]));
    });

    it("ignores turns with broken timings", () => {
        const m = mapLabels(
            [t("A", 0, Number.NaN), t("B", 0, 10_000)],
            [t("X", 0, 10_000)],
        );
        expect(m.carried).toEqual(new Map([["B", "X"]]));
    });

    it("maps text-only transcripts by order only when the counts match", () => {
        expect(
            mapLabels(null, null, {
                previousLabels: ["a", "b"],
                nextLabels: ["b", "a"],
            }).uncertain,
        ).toEqual(
            new Map([
                ["a", "b"],
                ["b", "a"],
            ]),
        );
        expect(
            mapLabels(null, null, {
                previousLabels: ["a"],
                nextLabels: ["a", "b"],
            }).uncertain.size,
        ).toBe(0);
    });
});
