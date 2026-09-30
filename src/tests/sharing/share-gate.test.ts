import { describe, expect, it } from "vitest";
import {
    evaluateShareGate,
    type ShareGateInput,
} from "@/lib/sharing/share-gate";

type Attribution = ShareGateInput["attributions"][number];

function named(
    transcriptionId: string,
    label: string,
    overrides: Partial<Attribution> = {},
): Attribution {
    return {
        transcriptionId,
        label,
        status: "confirmed",
        personId: `person-${label}`,
        markedUnknown: false,
        ...overrides,
    };
}

function gate(overrides: Partial<ShareGateInput>): ShareGateInput {
    return {
        transcripts: [
            { id: "t1", source: "riffado", labels: ["speaker_0", "speaker_1"] },
        ],
        attributions: [],
        unfinishedLearnRuns: 0,
        ...overrides,
    };
}

describe("evaluateShareGate", () => {
    it("needs a transcript", () => {
        expect(evaluateShareGate(gate({ transcripts: [] }))).toEqual([
            { kind: "no_transcript" },
        ]);
    });

    it("lists the labels nobody answered, per transcript", () => {
        expect(
            evaluateShareGate(
                gate({ attributions: [named("t1", "speaker_0")] }),
            ),
        ).toEqual([
            {
                kind: "unresolved_speakers",
                source: "riffado",
                labels: ["speaker_1"],
            },
        ]);
    });

    it("passes when every label has a person", () => {
        expect(
            evaluateShareGate(
                gate({
                    attributions: [
                        named("t1", "speaker_0"),
                        named("t1", "speaker_1"),
                    ],
                }),
            ),
        ).toEqual([]);
    });

    it("counts an explicit unknown speaker as an answer", () => {
        expect(
            evaluateShareGate(
                gate({
                    attributions: [
                        named("t1", "speaker_0"),
                        named("t1", "speaker_1", {
                            personId: null,
                            markedUnknown: true,
                        }),
                    ],
                }),
            ),
        ).toEqual([]);
    });

    it("does not count a suggestion, or a legacy confirmed row without a person", () => {
        const problems = evaluateShareGate(
            gate({
                attributions: [
                    named("t1", "speaker_0", { status: "suggested" }),
                    named("t1", "speaker_1", { personId: null }),
                ],
            }),
        );
        expect(problems).toEqual([
            {
                kind: "unresolved_speakers",
                source: "riffado",
                labels: ["speaker_0", "speaker_1"],
            },
        ]);
    });

    it("does not let one transcript's answer resolve another's label", () => {
        const problems = evaluateShareGate(
            gate({
                transcripts: [
                    { id: "t1", source: "riffado", labels: ["speaker_0"] },
                    { id: "t2", source: "plaud", labels: ["speaker_0"] },
                ],
                attributions: [named("t1", "speaker_0")],
            }),
        );
        expect(problems).toEqual([
            {
                kind: "unresolved_speakers",
                source: "plaud",
                labels: ["speaker_0"],
            },
        ]);
    });

    it("passes a transcript without speaker labels", () => {
        expect(
            evaluateShareGate(
                gate({
                    transcripts: [{ id: "t1", source: "riffado", labels: [] }],
                }),
            ),
        ).toEqual([]);
    });

    it("waits for unfinished Learn runs", () => {
        expect(
            evaluateShareGate(
                gate({
                    transcripts: [{ id: "t1", source: "riffado", labels: [] }],
                    unfinishedLearnRuns: 2,
                }),
            ),
        ).toEqual([{ kind: "learn_unfinished", runs: 2 }]);
    });
});
