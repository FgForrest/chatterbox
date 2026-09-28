import { describe, expect, it, vi } from "vitest";
import {
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
        // Both places the words stand, anchored exactly.
        expect(result.output.corrections).toEqual([
            expect.objectContaining({
                turnIndex: 0,
                charStart: 21,
                charEnd: 27,
            }),
            expect.objectContaining({
                turnIndex: 0,
                charStart: 30,
                charEnd: 36,
            }),
        ]);
        expect(result).toMatchObject({ windows: 1, repairs: 0 });
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
});
