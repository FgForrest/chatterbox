import { describe, expect, it, vi } from "vitest";
import {
    anchorMatches,
    remapCorrectionAnchors,
    wordsAt,
} from "@/lib/knowledge/correction-anchors";
import type { TranscriptTurn } from "@/lib/transcription/turns";

function turn(
    startMs: number,
    endMs: number,
    text: string,
    speaker = "speaker_0",
): TranscriptTurn {
    return { speaker, startMs, endMs, text };
}

function anchorOf(turns: TranscriptTurn[], turnIndex: number, heard: string) {
    const charStart = turns[turnIndex]?.text.indexOf(heard) ?? -1;
    if (charStart < 0)
        throw new Error(`"${heard}" is not in turn ${turnIndex}`);
    return { turnIndex, charStart, charEnd: charStart + heard.length, heard };
}

const before = [
    turn(0, 4000, "Dobrý den, tady Novák z Orionu."),
    turn(4000, 9000, "Ahoj Honzo, jak to jde s projektem Tavesi?"),
];

describe("anchorMatches", () => {
    it("holds only where the heard text stands at the offsets", () => {
        const anchor = anchorOf(before, 0, "Novák");
        expect(anchorMatches(anchor, before)).toBe(true);
        expect(anchorMatches({ ...anchor, charStart: 1 }, before)).toBe(false);
        expect(anchorMatches({ ...anchor, turnIndex: 5 }, before)).toBe(false);
        expect(anchorMatches(anchor, null)).toBe(false);
    });
});

describe("wordsAt", () => {
    it("matches letters case-blind the same way whatever the runtime's locale", () => {
        // A Turkish default locale lowercases "I" to a dotless "ı": the
        // server and a browser must still agree that "Ivo" is "ivo".
        const turkish = vi
            .spyOn(String.prototype, "toLocaleLowerCase")
            .mockImplementation(function (this: string) {
                return this.replaceAll("I", "ı").toLowerCase();
            });
        try {
            expect(wordsAt("Ivo a Ivana", 0, 3, "ivo")).toBe("Ivo");
        } finally {
            turkish.mockRestore();
        }
    });
});

describe("remapCorrectionAnchors", () => {
    it("never lands a remapped anchor inside a character", () => {
        const previous = [turn(0, 4000, "Cafe today, Cafe tomorrow.")];
        // Re-transcribed: the first word gains an accent written apart.
        const next = [turn(0, 4000, "Cafe\u0301 today, Cafe tomorrow.")];
        const anchor = anchorOf(previous, 0, "Cafe");
        const at = next[0]?.text.lastIndexOf("Cafe") ?? -1;
        expect(remapCorrectionAnchors([anchor], previous, next)).toEqual([
            { turnIndex: 0, charStart: at, charEnd: at + 4 },
        ]);
    });

    it("keeps anchors on an unchanged transcript", () => {
        const anchors = [
            anchorOf(before, 0, "Novák"),
            anchorOf(before, 1, "Tavesi"),
        ];
        expect(remapCorrectionAnchors(anchors, before, before)).toEqual([
            {
                turnIndex: 0,
                charStart: anchors[0]?.charStart,
                charEnd: anchors[0]?.charEnd,
            },
            {
                turnIndex: 1,
                charStart: anchors[1]?.charStart,
                charEnd: anchors[1]?.charEnd,
            },
        ]);
    });

    it("follows a turn with the same text to its new index", () => {
        const after = [
            turn(0, 2000, "Dobrý den,", "speaker_1"),
            turn(2000, 4000, "tady Novák z Orionu.", "speaker_1"),
            turn(
                4000,
                9000,
                "Ahoj Honzo, jak to jde s projektem Tavesi?",
                "speaker_0",
            ),
        ];
        const anchor = anchorOf(before, 1, "Tavesi");
        expect(remapCorrectionAnchors([anchor], before, after)).toEqual([
            {
                turnIndex: 2,
                charStart: anchor.charStart,
                charEnd: anchor.charEnd,
            },
        ]);
    });

    it("finds the heard text again in reworded turns over the same time", () => {
        const after = [
            turn(0, 2000, "Dobrý den,"),
            turn(2000, 4100, "tady je Novák, Orion."),
        ];
        expect(
            remapCorrectionAnchors(
                [anchorOf(before, 0, "Novák")],
                before,
                after,
            ),
        ).toEqual([{ turnIndex: 1, charStart: 8, charEnd: 13 }]);
    });

    it("drops an anchor whose heard text is gone, or far away in time", () => {
        const after = [
            turn(0, 4000, "Dobrý den, tady Novotný z Orionu."),
            turn(4000, 9000, "Ahoj Novák, jak to jde s projektem Tavesi?"),
        ];
        expect(
            remapCorrectionAnchors(
                [anchorOf(before, 0, "Novák")],
                before,
                after,
            ),
        ).toEqual([null]);
    });

    it("takes the occurrence nearest the anchor's time when the text repeats", () => {
        const previous = [turn(0, 10_000, "Honza říkal, že Honza přijde.")];
        const next = [turn(0, 10_000, "Honza říkal, že ten Honza přijde.")];
        const second = {
            turnIndex: 0,
            charStart: 16,
            charEnd: 21,
            heard: "Honza",
        };
        expect(previous[0]?.text.slice(16, 21)).toBe("Honza");
        expect(remapCorrectionAnchors([second], previous, next)).toEqual([
            { turnIndex: 0, charStart: 20, charEnd: 25 },
        ]);
    });

    it("keeps only the first of two anchors that land on the same words", () => {
        const previous = [turn(0, 10_000, "Honza a Honza.")];
        const next = [turn(0, 10_000, "Honza.")];
        const anchors = [
            { turnIndex: 0, charStart: 0, charEnd: 5, heard: "Honza" },
            { turnIndex: 0, charStart: 8, charEnd: 13, heard: "Honza" },
        ];
        expect(remapCorrectionAnchors(anchors, previous, next)).toEqual([
            { turnIndex: 0, charStart: 0, charEnd: 5 },
            null,
        ]);
    });

    it("drops everything when either side has no timed turns", () => {
        const anchor = anchorOf(before, 0, "Novák");
        expect(remapCorrectionAnchors([anchor], before, null)).toEqual([null]);
        expect(remapCorrectionAnchors([anchor], null, before)).toEqual([null]);
    });

    it("drops an anchor that no longer matched its own transcript", () => {
        expect(
            remapCorrectionAnchors(
                [{ turnIndex: 0, charStart: 0, charEnd: 5, heard: "Novák" }],
                before,
                before,
            ),
        ).toEqual([null]);
    });

    it("places a zero-length turn by its instant", () => {
        const previous = [
            turn(0, 3000, "Dobrý den."),
            turn(3000, 3000, "Novák."),
        ];
        const next = [turn(0, 4000, "Tady Novák."), turn(4000, 8000, "Novák.")];
        expect(
            remapCorrectionAnchors(
                [{ turnIndex: 1, charStart: 0, charEnd: 5, heard: "Novák" }],
                previous,
                next,
            ),
        ).toEqual([{ turnIndex: 0, charStart: 5, charEnd: 10 }]);
    });

    describe("on untimed turns (a Plaud transcript without times)", () => {
        const untimed = [
            turn(0, 0, "Tady Novák, vedu Orion.", "speaker_1"),
            turn(0, 0, "Pan Novák volal včera.", "speaker_2"),
        ];
        const anchor = anchorOf(untimed, 1, "Novák");

        it("keeps every anchor through an unchanged re-import", () => {
            expect(remapCorrectionAnchors([anchor], untimed, untimed)).toEqual([
                { turnIndex: 1, charStart: 4, charEnd: 9 },
            ]);
        });

        it("keeps an anchor where the same turn still has the words at the same place", () => {
            const next = [
                untimed[0] as TranscriptTurn,
                turn(0, 0, "Pan Novák volal v pondělí.", "speaker_2"),
            ];
            expect(remapCorrectionAnchors([anchor], untimed, next)).toEqual([
                { turnIndex: 1, charStart: 4, charEnd: 9 },
            ]);
        });

        it("never moves an anchor onto another turn's words", () => {
            const moved = [
                untimed[0] as TranscriptTurn,
                turn(0, 0, "Včera pan Novák volal.", "speaker_2"),
            ];
            expect(remapCorrectionAnchors([anchor], untimed, moved)).toEqual([
                null,
            ]);
        });

        it("drops an anchor when turns were added or removed, whatever stands at its place", () => {
            const said = [
                turn(0, 0, "Tady Novák.", "speaker_1"),
                turn(0, 0, "Jan, can you send it?", "speaker_2"),
            ];
            const jan = anchorOf(said, 1, "Jan");
            // A pair inserted before: turn 1 is another sentence now.
            const shifted = [
                turn(0, 0, "Tady Novák.", "speaker_1"),
                turn(0, 0, "Jan, bring the car.", "speaker_2"),
                turn(0, 0, "Ok.", "speaker_1"),
                turn(0, 0, "Jan, can you send it?", "speaker_2"),
            ];
            expect(remapCorrectionAnchors([jan], said, shifted)).toEqual([
                null,
            ]);
        });

        it("drops an anchor whose turn another speaker now says", () => {
            const relabelled = [
                untimed[0] as TranscriptTurn,
                turn(0, 0, "Pan Novák volal včera.", "speaker_1"),
            ];
            expect(
                remapCorrectionAnchors([anchor], untimed, relabelled),
            ).toEqual([null]);
        });

        it("holds a timed transcript replaced by an untimed one to the same rule", () => {
            const timed = [
                turn(0, 4000, "Tady Novák, vedu Orion.", "speaker_1"),
                turn(4000, 9000, "Pan Novák volal včera.", "speaker_2"),
            ];
            const reworded = [
                untimed[0] as TranscriptTurn,
                turn(0, 0, "Včera pan Novák volal.", "speaker_2"),
            ];
            expect(
                remapCorrectionAnchors(
                    [anchorOf(timed, 1, "Novák")],
                    timed,
                    reworded,
                ),
            ).toEqual([null]);
            expect(
                remapCorrectionAnchors(
                    [anchorOf(timed, 1, "Novák")],
                    timed,
                    untimed,
                ),
            ).toEqual([{ turnIndex: 1, charStart: 4, charEnd: 9 }]);
        });
    });
});
