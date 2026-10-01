import { describe, expect, it, vi } from "vitest";
import { LearnToolBudgetExhausted } from "@/lib/learn/errors";
import { learnOutputJsonSchema } from "@/lib/learn/output";
import {
    anchorCorrections,
    type LearnChatMessage,
    renderLearnTranscript,
    runFallbackPass,
} from "@/lib/learn/run-fallback";
import type { FoundEntity } from "@/lib/learn/tools";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 18_000,
        text: "Dobrý den. Máme dnes Tavesy a Tavesy znovu.",
    },
    {
        speaker: "speaker_1",
        startMs: 18_000,
        endMs: 40_000,
        text: "Ahoj, tady Jan. Vedu projekt Orion.",
    },
];

const tavesi: FoundEntity = {
    id: "e-tavesi",
    kind: "entity",
    typeKey: "organization",
    name: "Tavesi",
    scope: "org",
    reasons: ["edit"],
    score: 0.9,
};

function fakeChat(replies: string[]) {
    const calls: LearnChatMessage[][] = [];
    return {
        calls,
        chat: {
            complete: vi.fn(async (messages: LearnChatMessage[]) => {
                calls.push(messages);
                return replies.shift() ?? "{}";
            }),
        },
    };
}

const relations = [
    {
        key: "leads",
        label: "leads",
        subjectTypes: ["person"],
        objectTypes: ["project"],
        objectKind: "entity" as const,
    },
];

describe("runFallbackPass", () => {
    it("renders each turn with its index, time and label, the times the model must quote", () => {
        expect(renderLearnTranscript(TURNS, 0)).toBe(
            "[T0 00:00] speaker_0: Dobrý den. Máme dnes Tavesy a Tavesy znovu.\n[T1 00:18] speaker_1: Ahoj, tady Jan. Vedu projekt Orion.",
        );
    });

    it("finds mentions, looks each up once, and asks for the answer with only what was found", async () => {
        const lookup = {
            findEntities: vi.fn(async ({ text }: { text: string }) => ({
                byMeaning: false,
                entities: text === "Tavesy" ? [tavesi] : [],
            })),
        };
        const { chat, calls } = fakeChat([
            JSON.stringify({
                mentions: [
                    { text: "Tavesy", turn: 0 },
                    { text: "Tavesy", turn: 0 },
                    { text: "Orion", turn: 1 },
                ],
            }),
            JSON.stringify({
                speakers: [],
                corrections: [
                    {
                        turnIndex: 0,
                        // The model's offsets are off: the server finds the words.
                        charStart: 0,
                        charEnd: 6,
                        heard: "Tavesy",
                        kind: "correct",
                        target: { entityId: "e-tavesi" },
                        replacement: "Tavesi",
                    },
                ],
                facts: [],
                relationPhrases: [],
            }),
        ]);

        const result = await runFallbackPass({
            chat,
            lookup,
            turns: TURNS,
            language: "cs",
            relations,
            unnamedLabels: ["speaker_1"],
        });

        expect(lookup.findEntities).toHaveBeenCalledTimes(2);
        expect(calls).toHaveLength(2);
        const adjudication = JSON.stringify(calls[1]);
        expect(adjudication).toContain("e-tavesi");
        expect(adjudication).toContain("leads");
        expect(adjudication).toContain("speaker_1");
        // The place nearest the offset the model gave, anchored exactly.
        expect(result.output.corrections).toEqual([
            expect.objectContaining({
                turnIndex: 0,
                charStart: 21,
                charEnd: 27,
            }),
        ]);
        expect(result).toMatchObject({ windows: 1, repairs: 0 });
    });

    it("looks up a mention's other forms only when its words find nothing", async () => {
        const lookup = {
            findEntities: vi.fn(async ({ text }: { text: string }) => ({
                byMeaning: false,
                entities: text === "Tavesi" ? [tavesi] : [],
            })),
        };
        const { chat, calls } = fakeChat([
            JSON.stringify({
                mentions: [
                    { text: "Tavesy", turn: 0, forms: ["Tavesi", "Tavesy"] },
                    {
                        text: "Jan",
                        turn: 1,
                        forms: ["Honza", "Jenda", "Jeník"],
                    },
                    { text: "Orion", turn: 1, forms: "not a list" },
                ],
            }),
            JSON.stringify({
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            }),
        ]);
        await runFallbackPass({
            chat,
            lookup,
            turns: TURNS,
            language: "cs",
            relations,
            unnamedLabels: [],
        });
        // The words as said first; then other forms, by name alone.
        expect(lookup.findEntities.mock.calls.map((call) => call[0])).toEqual([
            { text: "Tavesy" },
            { text: "Jan" },
            { text: "Orion" },
            { text: "Tavesi", byName: true },
            { text: "Honza", byName: true },
            { text: "Jenda", byName: true },
        ]);
        const adjudication = JSON.parse(
            (calls[1]?.[1]?.content ?? "").split("\n")[1] ?? "{}",
        );
        expect(adjudication.notFound).toEqual(["Jan", "Orion"]);
        expect(JSON.stringify(adjudication.candidates)).toContain("e-tavesi");
    });

    it("takes a meaning alone for nothing found, and no form from nowhere", async () => {
        const meaningOnly: FoundEntity = {
            ...tavesi,
            id: "e-other",
            reasons: ["meaning"],
        };
        const lookup = {
            findEntities: vi.fn(async ({ text }: { text: string }) => ({
                byMeaning: true,
                entities: text === "Tavesy" ? [meaningOnly] : [],
            })),
        };
        const { chat, calls } = fakeChat([
            JSON.stringify({
                mentions: [
                    {
                        text: "Tavesy",
                        turn: 0,
                        forms: ["Project Falcon Internal", "Tavesi"],
                    },
                ],
            }),
            JSON.stringify({
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            }),
        ]);
        await runFallbackPass({
            chat,
            lookup,
            turns: TURNS,
            language: "cs",
            relations,
            unnamedLabels: [],
        });
        expect(lookup.findEntities.mock.calls.map((call) => call[0])).toEqual([
            { text: "Tavesy" },
            { text: "Tavesi", byName: true },
        ]);
        const adjudication = JSON.parse(
            (calls[1]?.[1]?.content ?? "").split("\n")[1] ?? "{}",
        );
        expect(adjudication.notFound).toEqual(["Tavesy"]);
    });

    it("leaves other forms for later windows' lookups", async () => {
        const lookup = {
            findEntities: vi.fn(async (_query: { text: string }) => ({
                byMeaning: false,
                entities: [],
            })),
        };
        const empty = JSON.stringify({
            speakers: [],
            corrections: [],
            facts: [],
            relationPhrases: [],
        });
        const { chat } = fakeChat([
            JSON.stringify({
                mentions: [{ text: "Tavesy", turn: 0, forms: ["Tavesi"] }],
            }),
            empty,
            JSON.stringify({ mentions: [{ text: "Orion", turn: 1 }] }),
            empty,
        ]);
        await runFallbackPass({
            chat,
            lookup,
            turns: TURNS,
            language: "cs",
            relations,
            unnamedLabels: [],
            windowChars: 60,
            // One for this window's mention, the rest kept for the next.
            lookupBudget: 1 + 40,
        });
        expect(lookup.findEntities.mock.calls.map((call) => call[0])).toEqual([
            { text: "Tavesy" },
            { text: "Orion" },
        ]);
    });

    it("asks once to repair an answer that is not the shape, and gives up on a second", async () => {
        const lookup = {
            findEntities: vi.fn(async () => ({
                byMeaning: false,
                entities: [],
            })),
        };
        const empty = JSON.stringify({
            speakers: [],
            corrections: [],
            facts: [],
            relationPhrases: [],
        });
        const repaired = fakeChat(['{"mentions":[]}', "not json", empty]);
        const ok = await runFallbackPass({
            chat: repaired.chat,
            lookup,
            turns: TURNS,
            language: "cs",
            relations,
            unnamedLabels: [],
        });
        expect(ok.repairs).toBe(1);
        expect(ok.output.facts).toEqual([]);

        const broken = fakeChat(['{"mentions":[]}', "nope", "still nope"]);
        await expect(
            runFallbackPass({
                chat: broken.chat,
                lookup,
                turns: TURNS,
                language: "cs",
                relations,
                unnamedLabels: [],
            }),
        ).rejects.toThrow(/not the shape/);
    });

    it("gives the model the answer's exact shape, and the repair too", async () => {
        // Described only in prose, the model named the fields its own way
        // (`speakerLabel`, `turn`, `targetId`, evidence as quoted lines):
        // the strict schema refused it, the repair had no shape to aim at,
        // and every window's proposals were lost (the Learn pilot, 2026-09-29).
        const lookup = {
            findEntities: vi.fn(async () => ({
                byMeaning: false,
                entities: [],
            })),
        };
        const empty = JSON.stringify({
            speakers: [],
            corrections: [],
            facts: [],
            relationPhrases: [],
        });
        const { chat, calls } = fakeChat([
            '{"mentions":[]}',
            "not json",
            empty,
        ]);
        await runFallbackPass({
            chat,
            lookup,
            turns: TURNS,
            language: "cs",
            relations,
            unnamedLabels: ["speaker_0"],
        });
        const schema = JSON.stringify(learnOutputJsonSchema());
        const answer = calls[1]?.map((m) => m.content).join("\n") ?? "";
        const repair = calls[2]?.map((m) => m.content).join("\n") ?? "";
        for (const prompt of [answer, repair]) {
            expect(prompt).toContain(schema);
        }
    });

    it("reads a long transcript in windows and joins their answers", async () => {
        const long: TranscriptTurn[] = Array.from({ length: 6 }, (_, i) => ({
            speaker: `speaker_${i % 2}`,
            startMs: i * 10_000,
            endMs: (i + 1) * 10_000,
            text: `Turn ${i} ${"x".repeat(40)}`,
        }));
        const answer = (turnIndex: number) =>
            JSON.stringify({
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [
                    {
                        phrase: `phrase ${turnIndex}`,
                        subject: { speakerLabel: "speaker_0" },
                        object: { literal: "x" },
                        start: "00:00",
                        end: "00:10",
                        sensitivity: "none",
                    },
                ],
            });
        const { chat } = fakeChat([
            '{"mentions":[]}',
            answer(0),
            '{"mentions":[]}',
            answer(3),
        ]);
        const result = await runFallbackPass({
            chat,
            lookup: {
                findEntities: vi.fn(async () => ({
                    byMeaning: false,
                    entities: [],
                })),
            },
            turns: long,
            language: "en",
            relations,
            unnamedLabels: [],
            windowChars: 230,
        });
        expect(result.windows).toBe(2);
        expect(result.output.relationPhrases.map((p) => p.phrase)).toEqual([
            "phrase 0",
            "phrase 3",
        ]);
    });

    it("keeps each window's new-record refs apart, and says which words found nothing", async () => {
        const long: TranscriptTurn[] = Array.from({ length: 6 }, (_, i) => ({
            speaker: `speaker_${i % 2}`,
            startMs: i * 10_000,
            endMs: (i + 1) * 10_000,
            text: `Turn ${i} Veltrix ${"x".repeat(40)}`,
        }));
        const answer = JSON.stringify({
            newRecords: [
                {
                    ref: "n1",
                    kind: "entity",
                    typeKey: "organization",
                    name: "Veltrix",
                    speakerLabel: null,
                    evidence: ["00:00"],
                    reason: "a client",
                },
            ],
            speakers: [],
            corrections: [],
            facts: [
                {
                    subject: { speakerLabel: "speaker_0" },
                    relationKey: "works_for",
                    object: { newRef: "n1" },
                    start: "00:00",
                    end: "00:10",
                    speakerLabel: "speaker_0",
                    sensitivity: "none",
                },
            ],
            relationPhrases: [],
        });
        const mentions = (turn: number) =>
            JSON.stringify({ mentions: [{ text: "Veltrix", turn }] });
        const { chat, calls } = fakeChat([
            mentions(0),
            answer,
            mentions(3),
            answer,
        ]);
        const result = await runFallbackPass({
            chat,
            lookup: {
                findEntities: vi.fn(async () => ({
                    byMeaning: false,
                    entities: [],
                })),
            },
            turns: long,
            language: "en",
            relations,
            entityTypes: [{ key: "organization", label: "Organization" }],
            unnamedLabels: [],
            windowChars: 260,
        });
        expect(result.windows).toBe(2);
        expect(result.output.newRecords.map((record) => record.ref)).toEqual([
            "w1:n1",
            "w2:n1",
        ]);
        expect(result.output.facts.map((fact) => fact.object)).toEqual([
            { newRef: "w1:n1" },
            { newRef: "w2:n1" },
        ]);
        const adjudication = JSON.parse(
            (calls[1]?.[1]?.content ?? "").split("\n")[1] ?? "{}",
        );
        expect(adjudication).toMatchObject({
            notFound: ["Veltrix"],
            entityTypes: [{ key: "organization", label: "Organization" }],
        });
    });

    describe("found in review", () => {
        const empty = JSON.stringify({
            speakers: [],
            corrections: [],
            facts: [],
            relationPhrases: [],
        });

        it("looks up only mentions that stand in the turn they name", async () => {
            const lookup = {
                findEntities: vi.fn(async (_query: { text: string }) => ({
                    byMeaning: false,
                    entities: [],
                })),
            };
            const { chat } = fakeChat([
                JSON.stringify({
                    mentions: [
                        { text: "Tavesy", turn: 0 },
                        { text: "PRIVATE-CODENAME", turn: 0 },
                        { text: "Orion", turn: 7 },
                        { text: "Orion", turn: 0 },
                    ],
                }),
                empty,
            ]);
            await runFallbackPass({
                chat,
                lookup,
                turns: TURNS,
                language: "cs",
                relations,
                unnamedLabels: [],
            });
            expect(
                lookup.findEntities.mock.calls.map((call) => call[0]),
            ).toEqual([{ text: "Tavesy" }]);
        });

        it("anchors a correction at the one occurrence nearest the model's offset, as a whole word", () => {
            const turns = [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 5_000,
                    text: "Díky Janete, Jan to ví a Jan taky.",
                },
            ];
            const at = (charStart: number) =>
                anchorCorrections(
                    [
                        {
                            turnIndex: 0,
                            charStart,
                            charEnd: charStart + 3,
                            heard: "Jan",
                            kind: "link",
                            target: { personId: "p-jan" },
                            replacement: null,
                        },
                    ],
                    turns,
                ).map((correction) => correction.charStart);
            // Offset 5 is "Jan" inside "Janete": the nearest whole word wins.
            expect(at(5)).toEqual([13]);
            expect(at(22)).toEqual([25]);
        });

        it("takes no word whose accent is written after it for the word without", () => {
            const turns = [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 5_000,
                    text: "Cafe\u0301 a Cafe dnes.",
                },
            ];
            expect(
                anchorCorrections(
                    [
                        {
                            turnIndex: 0,
                            charStart: 0,
                            charEnd: 4,
                            heard: "Cafe",
                            kind: "link",
                            target: { entityId: "e-cafe" },
                            replacement: null,
                        },
                    ],
                    turns,
                ).map((correction) => correction.charStart),
            ).toEqual([8]);
        });

        it("goes on with what it found once the run's lookups are spent", async () => {
            let left = 1;
            const lookup = {
                findEntities: vi.fn(async ({ text }: { text: string }) => {
                    if (left-- <= 0) throw new LearnToolBudgetExhausted();
                    return {
                        byMeaning: false,
                        entities: text === "Tavesy" ? [tavesi] : [],
                    };
                }),
            };
            const { chat, calls } = fakeChat([
                JSON.stringify({
                    mentions: [
                        { text: "Tavesy", turn: 0 },
                        { text: "Orion", turn: 1 },
                    ],
                }),
                empty,
            ]);
            const result = await runFallbackPass({
                chat,
                lookup,
                turns: TURNS,
                language: "cs",
                relations,
                unnamedLabels: [],
            });
            expect(result.lookups).toBe(1);
            expect(JSON.stringify(calls[1])).toContain("e-tavesi");
        });

        it("keeps the windows that answered when one did not", async () => {
            const long: TranscriptTurn[] = Array.from(
                { length: 6 },
                (_, i) => ({
                    speaker: `speaker_${i % 2}`,
                    startMs: i * 10_000,
                    endMs: (i + 1) * 10_000,
                    text: `Turn ${i} ${"x".repeat(40)}`,
                }),
            );
            const { chat } = fakeChat([
                '{"mentions":[]}',
                "nope",
                "still nope",
                '{"mentions":[]}',
                empty,
            ]);
            const result = await runFallbackPass({
                chat,
                lookup: {
                    findEntities: vi.fn(async () => ({
                        byMeaning: false,
                        entities: [],
                    })),
                },
                turns: long,
                language: "en",
                relations,
                unnamedLabels: [],
                windowChars: 230,
            });
            expect(result).toMatchObject({ windows: 2, failedWindows: 1 });
        });
    });
});
