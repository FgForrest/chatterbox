import { describe, expect, it, vi } from "vitest";
import { matchNames } from "@/lib/knowledge/name-match";
import { stemVariants } from "@/lib/knowledge/stemming";
import { runCorrectionPass } from "@/lib/learn/correction-pass";
import { renamedRecordPlaces } from "@/lib/learn/new-record-rename";
import type { LearnNewRecord, LearnOutput } from "@/lib/learn/output";
import { runBridgePass } from "@/lib/learn/run-bridge";
import {
    anchorCorrections,
    NAME_SPELLING_RULE,
    runFallbackPass,
} from "@/lib/learn/run-fallback";
import { type LearnRunFrame, validateLearnOutput } from "@/lib/learn/validate";
import { MAX_NEW_RECORDS } from "@/lib/learn/validate-new-records";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const turns: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Klient CHVEX používá Veloru. Složku pojmenuj CHVEX, pak probereme migraci a úkoly.",
    },
    {
        speaker: "speaker_1",
        startMs: 10_000,
        endMs: 20_000,
        text: "S CHVEXem projdeme systém Velora.",
    },
];

const frame: LearnRunFrame = {
    revision: 1,
    currentRevision: 1,
    turns,
    language: "ces",
    provider: "fixture-stt",
    people: new Map(),
    entities: new Map(),
    entityTypes: new Set(["organization", "product", "term", "project"]),
    relations: new Map(),
    answeredLabels: new Map(),
    confirmedHeardAs: new Set(),
    knownFacts: new Map(),
    dismissed: new Set(),
};

function record(name: string, typeKey = "organization"): LearnNewRecord {
    return {
        ref: "n1",
        kind: "entity",
        typeKey,
        name,
        speakerLabel: null,
        evidence: ["00:00"],
        reason: "Jméno klienta.",
    };
}

function output(extra: Partial<LearnOutput> = {}): LearnOutput {
    return {
        newRecords: [],
        speakers: [],
        corrections: [],
        facts: [],
        relationPhrases: [],
        ...extra,
    };
}

describe("Learn new-record recall evidence", () => {
    it.each([
        ["QRS", "QRSčko"],
        ["TZ", "TZka"],
        ["NBI", "NBIem"],
    ])("keeps the acronym %s when its evidence uses the spoken form %s", (name, heard) => {
        const result = validateLearnOutput(
            output({ newRecords: [record(name, "term")] }),
            {
                ...frame,
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 1000,
                        text: `Použijeme ${heard}.`,
                    },
                ],
            },
        );
        expect(result.items).toHaveLength(1);
        expect(result.dropped).toEqual({});
    });

    it("prioritizes grounded mishearings and frequent names before applying the cap", () => {
        const rare = Array.from({ length: MAX_NEW_RECORDS }, (_, index) => ({
            ...record(`Veltrix${index}`),
            ref: `r${index}`,
        }));
        const crowded = [
            {
                ...(turns[0] as TranscriptTurn),
                text: `${rare.map((one) => one.name).join(" ")} CHVEX. Velora Velora Velora.`,
            },
        ];
        const result = validateLearnOutput(
            output({
                newRecords: [
                    ...rare,
                    record("ČVEX"),
                    { ...record("Velora", "product"), ref: "n2" },
                ],
                corrections: anchorCorrections(
                    [
                        {
                            turnIndex: 0,
                            charStart: 0,
                            charEnd: 1,
                            heard: "CHVEX",
                            replacement: "ČVEX",
                            kind: "correct",
                            target: { newRef: "n1" },
                        },
                    ],
                    crowded,
                ),
            }),
            { ...frame, turns: crowded },
        );
        const names = result.items
            .filter((item) => item.kind === "new_record")
            .map((item) => item.payload.name);
        expect(names).toHaveLength(MAX_NEW_RECORDS);
        expect(names.slice(0, 2)).toEqual(["ČVEX", "Velora"]);
        expect(result.dropped.budget).toBe(2);
    });

    it("rewrites a renamed acronym and its inflections without matching longer names", () => {
        expect(
            renamedRecordPlaces("CHVEX", "ČVEX", turns).map((place) => [
                place.heard,
                place.replacement,
            ]),
        ).toEqual([
            ["CHVEX", "ČVEX"],
            ["CHVEX", "ČVEX"],
            ["CHVEXem", "ČVEXem"],
        ]);
        expect(
            renamedRecordPlaces("CHVEX", "ČVEX", [
                { ...(turns[0] as TranscriptTurn), text: "CHVEXserver" },
            ]),
        ).toEqual([]);
    });

    it("leaves declension changes it cannot derive to the correction pass", () => {
        expect(
            renamedRecordPlaces("Jitka Dvorakova", "Jitka Dvořáková", [
                {
                    ...(turns[0] as TranscriptTurn),
                    text: "S Jitkou Dvorakovou.",
                },
            ]),
        ).toEqual([]);
        expect(
            renamedRecordPlaces("Veltrix", "Velora", [
                { ...(turns[0] as TranscriptTurn), text: "S Veltrixem." },
            ]),
        ).toEqual([]);
    });

    it("does not rewrite the transcript when a rename adds or drops words", () => {
        const text = "V Orbita jsme to probrali.";
        expect(
            renamedRecordPlaces("Orbita", "Orbita Systems", [
                { speaker: "speaker_0", startMs: 0, endMs: 1000, text },
            ]),
        ).toEqual([]);
        expect(
            renamedRecordPlaces("Orbita Systems", "Orbita", [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 1000,
                    text: "V Orbita Systems jsme to probrali.",
                },
            ]),
        ).toEqual([]);
    });

    it("preserves a case ending when the heard name uses decomposed diacritics", () => {
        const text = "S Dvora\u0301kem.";
        const places = renamedRecordPlaces("Dvorák", "Dvořák", [
            { speaker: "speaker_0", startMs: 0, endMs: 1000, text },
        ]);
        expect(places).toEqual([
            {
                turnIndex: 0,
                charStart: 2,
                charEnd: text.length - 1,
                heard: "Dvora\u0301kem",
                replacement: "Dvořákem",
            },
        ]);
    });

    it("keeps a corrected acronym with anchored heard words and an inflected replacement", () => {
        const corrections = anchorCorrections(
            [
                {
                    turnIndex: 1,
                    charStart: 0,
                    charEnd: 1,
                    heard: "CHVEXem",
                    kind: "correct",
                    target: { newRef: "n1" },
                    replacement: "ČVEXem",
                },
            ],
            turns,
        );
        const result = validateLearnOutput(
            output({ newRecords: [record("ČVEX")], corrections }),
            frame,
        );
        expect(result.dropped).toEqual({});
        expect(result.items.map((item) => item.kind)).toEqual([
            "new_record",
            "correction",
        ]);
        expect(result.items[0]?.payload).toMatchObject({ name: "ČVEX" });
    });

    it("requires grounded evidence even when a model gives a corrected spelling", () => {
        const result = validateLearnOutput(
            output({ newRecords: [record("ČVEX")] }),
            frame,
        );
        expect(result.items).toEqual([]);
        expect(result.dropped).toEqual({ notInEvidence: 1 });
    });

    it("keeps organizations named as folders and products that are the meeting subject", () => {
        const result = validateLearnOutput(
            output({
                newRecords: [
                    record("CHVEX"),
                    { ...record("Velora", "product"), ref: "n2" },
                ],
            }),
            frame,
        );
        expect(result.items.map((item) => item.payload)).toMatchObject([
            { name: "CHVEX", typeKey: "organization" },
            { name: "Velora", typeKey: "product" },
        ]);
    });

    it.each([
        ["úkoly", "term"],
        ["migraci a úkoly", "project"],
    ])("drops the generic word or topic phrase %s", (name, typeKey) => {
        const result = validateLearnOutput(
            output({ newRecords: [record(name, typeKey)] }),
            frame,
        );
        expect(result.items).toEqual([]);
        expect(result.dropped).toEqual({ generic: 1 });
    });

    it("matches an inflected heard acronym by stem without adding another alias", () => {
        const matches = matchNames(
            "CHVEXem",
            [{ id: "client", names: ["CHVEX"] }],
            { key: "cs", stem: (word) => stemVariants(word, "cs") },
        );
        expect(matches).toContainEqual(
            expect.objectContaining({ id: "client", reason: "stem" }),
        );
    });

    it("gives both Learn paths the recall and paired-evidence instructions", async () => {
        const bridge = {
            complete: vi.fn().mockResolvedValue(JSON.stringify(output())),
        };
        const chat = {
            complete: vi
                .fn()
                .mockResolvedValueOnce('{"mentions":[]}')
                .mockResolvedValueOnce(JSON.stringify(output())),
        };
        const input = {
            turns,
            language: "ces",
            relations: [],
            entityTypes: [{ key: "organization", label: "Organization" }],
            unnamedLabels: [],
        };
        await runBridgePass({ ...input, chat: bridge, token: "test" });
        await runFallbackPass({
            ...input,
            chat,
            lookup: { findEntities: async () => ({ entities: [] }) },
        });
        for (const system of [
            bridge.complete.mock.calls[0]?.[0].system,
            chat.complete.mock.calls[1]?.[0][0].content,
        ]) {
            expect(system).toContain(NAME_SPELLING_RULE);
            expect(system).toContain(
                "including the product this meeting is about",
            );
            expect(system).toContain("always include a `correct` correction");
            expect(system).toContain(
                "UI labels, task descriptions or topic phrases",
            );
        }
    });

    it("gives the correction pass the same diacritic and inflected-hearing guidance", async () => {
        const chat = { complete: vi.fn().mockResolvedValue('{"fixes":[]}') };
        await runCorrectionPass({
            path: "fallback",
            chat,
            bridge: { complete: vi.fn() },
            token: "test",
            turns,
            language: "ces",
            almanac: [],
            corrected: [],
        });
        expect(chat.complete.mock.calls[0]?.[0][0].content).toContain(
            NAME_SPELLING_RULE,
        );
        expect(chat.complete.mock.calls[0]?.[0][0].content).toContain(
            "including inflected occurrences",
        );
    });
});
