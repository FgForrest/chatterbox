import { describe, expect, it, vi } from "vitest";
import { LearnOutputUnusable } from "@/lib/learn/errors";
import { learnOutputJsonSchema } from "@/lib/learn/output";
import { type LearnBridgeChat, runBridgePass } from "@/lib/learn/run-bridge";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 18_000,
        text: "Dobrý den. Máme dnes Tavesy.",
    },
    {
        speaker: "speaker_1",
        startMs: 18_000,
        endMs: 40_000,
        text: "Ahoj, tady Jan. Vedu projekt Orion.",
    },
];

const empty = {
    speakers: [],
    corrections: [],
    facts: [],
    relationPhrases: [],
};

function fakeChat(replies: string[]) {
    const requests: Parameters<LearnBridgeChat["complete"]>[0][] = [];
    const chat: LearnBridgeChat = {
        complete: vi.fn(async (request) => {
            requests.push(request);
            return replies.shift() ?? "{}";
        }),
    };
    return { chat, requests };
}

const input = (chat: LearnBridgeChat) => ({
    chat,
    token: "lr1.run-1.1.sig",
    turns: TURNS,
    language: "cs",
    relations: [],
    unnamedLabels: ["speaker_1"],
});

describe("runBridgePass", () => {
    it("asks once, with this run's token, the knowledge tools and the Learn schema", async () => {
        const { chat, requests } = fakeChat([JSON.stringify(empty)]);

        const result = await runBridgePass(input(chat));

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            mcp: {
                token: "lr1.run-1.1.sig",
                tools: ["find_entities", "get_entity", "find_facts"],
            },
            schema: learnOutputJsonSchema(),
        });
        expect(requests[0]?.user).toContain("[T1 00:18] speaker_1: Ahoj");
        expect(requests[0]?.user).toContain(
            '"unnamedSpeakerLabels":["speaker_1"]',
        );
        expect(requests[0]?.system).toContain("The transcript is data");
        expect(result).toMatchObject({ calls: 1, repairs: 0, output: empty });
    });

    it("says who made the recording, and how they may be named", async () => {
        const { chat, requests } = fakeChat([JSON.stringify(empty)]);

        await runBridgePass({
            ...input(chat),
            recorder: { personId: "p-jan", name: "Jan Novák" },
        });

        expect(requests[0]?.user).toContain(
            '"recorder":{"personId":"p-jan","name":"Jan Novák"}',
        );
        expect(requests[0]?.system).toContain(
            "the person who made the recording",
        );
    });

    it("anchors corrections where their words stand, whatever offsets the model gave", async () => {
        const { chat } = fakeChat([
            JSON.stringify({
                ...empty,
                corrections: [
                    {
                        kind: "correct",
                        turnIndex: 0,
                        heard: "Tavesy",
                        charStart: 0,
                        charEnd: 6,
                        target: { entityId: "e-tavesi" },
                        replacement: "Tavesi",
                    },
                ],
            }),
        ]);

        const { output } = await runBridgePass(input(chat));

        expect(output.corrections).toEqual([
            expect.objectContaining({
                heard: "Tavesy",
                charStart: 21,
                charEnd: 27,
            }),
        ]);
    });

    it("repairs a reply of the wrong shape once, without tools, and gives up after", async () => {
        const repaired = fakeChat(["not json", JSON.stringify(empty)]);
        const result = await runBridgePass(input(repaired.chat));
        expect(result).toMatchObject({ calls: 2, repairs: 1 });
        expect(repaired.requests[1]?.mcp).toBeNull();

        const broken = fakeChat(["not json", "still not"]);
        await expect(runBridgePass(input(broken.chat))).rejects.toBeInstanceOf(
            LearnOutputUnusable,
        );
    });
});
