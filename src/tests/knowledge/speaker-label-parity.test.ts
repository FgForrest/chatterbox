/**
 * The speaker tags a person can name and the labels the server counts must be
 * the same set. The share gate refuses a recording with an unnamed label, so
 * a label the UI never shows would block sharing with nothing to click, and a
 * tag the server never counts would be named for nothing.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
    decryptJsonField: (value: unknown) => value,
}));

const { transcriptSpeakerTags } = await import(
    "@/components/dashboard/transcription-panel"
);
const { speakerLabelsForTranscript } = await import(
    "@/lib/knowledge/speaker-label-rules"
);
const { transcriptSpeakerLabels } = await import(
    "@/lib/knowledge/speaker-labels"
);

const cases = [
    {
        name: "timed turns with padded, repeated and placeholder labels",
        source: "riffado",
        model: "scribe_v2+diarize",
        text: "ignored",
        turns: [
            { speaker: "speaker_1 ", startMs: 0, endMs: 1, text: "a" },
            { speaker: "", startMs: 1, endMs: 2, text: "b" },
            { speaker: "speaker", startMs: 2, endMs: 3, text: "c" },
            { speaker: "speaker_0", startMs: 3, endMs: 4, text: "d" },
            { speaker: "speaker_1", startMs: 4, endMs: 5, text: "e" },
        ],
    },
    {
        name: "an overlong label",
        source: "plaud",
        model: "plaud",
        text: "ignored",
        turns: [{ speaker: "x".repeat(70), startMs: 0, endMs: 1, text: "a" }],
    },
    {
        name: "a diarized text transcript",
        source: "plaud",
        model: "plaud",
        text: "Jana: Hello\nPetr: Hi\nJana: Bye",
        turns: null,
    },
    {
        name: "a prompt-based transcript with Name: lines",
        source: "riffado",
        model: "gemini-2.0-flash",
        text: "Jana: Hello\nPetr: Hi",
        turns: null,
    },
];

describe("speaker label parity", () => {
    for (const input of cases) {
        it(`agrees for ${input.name}`, () => {
            const tags = transcriptSpeakerTags(input).map((tag) => tag.speaker);
            expect(tags).toEqual(speakerLabelsForTranscript(input));
            expect(tags).toEqual(transcriptSpeakerLabels(input));
        });
    }
});
