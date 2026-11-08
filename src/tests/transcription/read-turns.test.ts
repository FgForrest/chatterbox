import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

import { encryptJsonField } from "../../lib/encryption/fields";
import { readTranscriptTurns } from "../../lib/transcription/read-turns";

const turns = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Ahoj" },
    { speaker: "speaker_1", startMs: 1000, endMs: 2000, text: "Zdravim" },
];

describe("readTranscriptTurns", () => {
    it("round-trips an encrypted turn array", () => {
        expect(readTranscriptTurns({ turns: encryptJsonField(turns) })).toEqual(
            turns,
        );
    });

    it.each(
        [[0], [0, 1], ["0"], [NaN], [Infinity], null, "bad"].map((value) => [
            value,
        ]),
    )("drops malformed optional timing: %j", (sentenceStartsMs) => {
        const first = turns[0];
        const value = sentenceStartsMs as unknown;
        const expected =
            Array.isArray(value) && value.length === 1 && value[0] === 0
                ? { ...first, sentenceStartsMs: [0] }
                : first;
        expect(
            readTranscriptTurns({
                turns: [{ ...first, sentenceStartsMs: value }],
            }),
        ).toEqual([expected]);
    });

    it.each([
        [[-1, 800]],
        [[900, 800]],
    ])("drops negative or decreasing sentence starts: %j", (sentenceStartsMs) => {
        const turn = { ...turns[0], text: "Hello. Again." };
        expect(
            readTranscriptTurns({ turns: [{ ...turn, sentenceStartsMs }] }),
        ).toEqual([turn]);
    });

    it("round-trips encrypted sentence starts", () => {
        const timed = [
            { ...turns[0], text: "Hello. Again.", sentenceStartsMs: [0, 800] },
        ];
        expect(readTranscriptTurns({ turns: encryptJsonField(timed) })).toEqual(
            timed,
        );
    });

    it("returns null for a transcript with no turns", () => {
        expect(readTranscriptTurns({ turns: null })).toBeNull();
        expect(readTranscriptTurns({})).toBeNull();
        expect(readTranscriptTurns(null)).toBeNull();
    });

    it("returns null for an empty stored array", () => {
        expect(readTranscriptTurns({ turns: encryptJsonField([]) })).toBeNull();
    });

    it("passes through a legacy plaintext array", () => {
        expect(readTranscriptTurns({ turns })).toEqual(turns);
    });
});
