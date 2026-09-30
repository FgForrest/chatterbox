import { describe, expect, it } from "vitest";
import {
    type LabelMapping,
    type RemappableAttribution,
    remapAttributionRows,
} from "@/lib/knowledge/label-mapping";

const mapping: LabelMapping = {
    carried: new Map([
        ["speaker_0", "speaker_1"],
        ["speaker_2", "speaker_2"],
    ]),
    uncertain: new Map([
        ["speaker_1", "speaker_0"],
        ["speaker_3", "speaker_3"],
    ]),
};

function row(overrides: Partial<RemappableAttribution>): RemappableAttribution {
    return {
        label: "speaker_0",
        personId: "person-jana",
        status: "confirmed",
        source: "user",
        markedUnknown: false,
        confirmedByUserId: "user-alice",
        confidence: 0.9,
        evidenceStartMs: 12_000,
        ...overrides,
    };
}

describe("remapAttributionRows", () => {
    it("keeps a carried row as it was, except the evidence time", () => {
        expect(remapAttributionRows([row({})], mapping)).toEqual([
            row({ label: "speaker_1", evidenceStartMs: null }),
        ]);
    });

    it("turns a named row with an uncertain match into a suggestion nobody confirmed", () => {
        expect(
            remapAttributionRows([row({ label: "speaker_1" })], mapping),
        ).toEqual([
            row({
                label: "speaker_0",
                status: "suggested",
                source: "heuristic",
                confirmedByUserId: null,
                evidenceStartMs: null,
            }),
        ]);
    });

    it("keeps a carried unknown unknown", () => {
        const unknown = row({
            label: "speaker_2",
            personId: null,
            markedUnknown: true,
        });
        expect(remapAttributionRows([unknown], mapping)).toEqual([
            { ...unknown, evidenceStartMs: null },
        ]);
    });

    it("drops what has nothing to offer on an uncertain match", () => {
        expect(
            remapAttributionRows(
                [
                    row({
                        label: "speaker_3",
                        personId: null,
                        markedUnknown: true,
                    }),
                    row({ label: "speaker_1", status: "rejected" }),
                    row({ label: "speaker_0", status: "rejected" }),
                ],
                mapping,
            ),
        ).toEqual([]);
    });

    it("drops rows whose label has no match", () => {
        expect(
            remapAttributionRows([row({ label: "speaker_9" })], mapping),
        ).toEqual([]);
    });

    it("keeps a machine suggestion a suggestion on a carried label", () => {
        const suggestion = row({
            status: "suggested",
            source: "llm",
            confirmedByUserId: null,
        });
        expect(remapAttributionRows([suggestion], mapping)).toEqual([
            { ...suggestion, label: "speaker_1", evidenceStartMs: null },
        ]);
    });
});
