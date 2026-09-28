import { describe, expect, it } from "vitest";
import {
    isPlaceholderSpeakerLabel,
    labelsFromTurns,
    speakerKey,
    speakerLabelsForTranscript,
} from "@/lib/knowledge/speaker-label-rules";

const turn = (speaker: string) => ({ speaker });

describe("isPlaceholderSpeakerLabel", () => {
    it("treats empty and Speechmatics' unattributed label as no one", () => {
        expect(isPlaceholderSpeakerLabel("")).toBe(true);
        expect(isPlaceholderSpeakerLabel("  ")).toBe(true);
        expect(isPlaceholderSpeakerLabel("speaker")).toBe(true);
        expect(isPlaceholderSpeakerLabel(" Speaker ")).toBe(true);
        expect(isPlaceholderSpeakerLabel("speaker_0")).toBe(false);
        expect(isPlaceholderSpeakerLabel("Jana")).toBe(false);
    });
});

describe("speakerKey", () => {
    it("trims and caps a label at 64 characters", () => {
        expect(speakerKey("Jan ")).toBe("Jan");
        expect(speakerKey(" speaker_1")).toBe("speaker_1");
        expect(speakerKey("x".repeat(70))).toBe("x".repeat(64));
    });
});

describe("labelsFromTurns", () => {
    it("keeps real labels in first-appearance order, as keys", () => {
        expect(
            labelsFromTurns([
                turn("speaker_1"),
                turn(""),
                turn("speaker_0"),
                turn("speaker"),
                turn("speaker_1 "),
                turn("speaker_0"),
            ]),
        ).toEqual(["speaker_1", "speaker_0"]);
    });
});

describe("speakerLabelsForTranscript", () => {
    const dialog = "speaker_0: Hello\nspeaker_1: Hi\nspeaker_0: Bye";

    it("uses stored turns when there are any", () => {
        expect(
            speakerLabelsForTranscript({
                source: "riffado",
                model: "whisper-1",
                text: "ignored",
                turns: [turn("B "), turn("A"), turn("B")],
            }),
        ).toEqual(["B", "A"]);
    });

    it("finds no speakers in a prompt-based transcript with Name: lines", () => {
        expect(
            speakerLabelsForTranscript({
                source: "riffado",
                model: "gemini-2.0-flash",
                text: "Jana: Hello\nPetr: Hi",
                turns: null,
            }),
        ).toEqual([]);
    });

    it("parses the labels of a diarized text transcript", () => {
        expect(
            speakerLabelsForTranscript({
                source: "riffado",
                model: "scribe_v2+diarize",
                text: dialog,
                turns: [],
            }),
        ).toEqual(["speaker_0", "speaker_1"]);
        expect(
            speakerLabelsForTranscript({
                source: "plaud",
                model: "plaud",
                text: dialog,
            }),
        ).toEqual(["speaker_0", "speaker_1"]);
    });

    it("returns nothing for a diarized transcript that is plain prose", () => {
        expect(
            speakerLabelsForTranscript({
                source: "plaud",
                text: "Just one block of text without labels.",
            }),
        ).toEqual([]);
    });
});
