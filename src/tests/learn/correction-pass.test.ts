import { describe, expect, it, vi } from "vitest";
import {
    type ProposedFix,
    planFixes,
    runCorrectionPass,
    wholeWordSpans,
} from "@/lib/learn/correction-pass";
import { LearnOutputUnusable } from "@/lib/learn/errors";
import { renderTurnsForLlm, renderTurnsForPeople } from "@/lib/learn/render";
import type { TranscriptTurn } from "@/lib/transcription/turns";

function turn(text: string, index = 0): TranscriptTurn {
    return {
        speaker: `speaker_${index % 2}`,
        text,
        startMs: index * 10_000,
        endMs: index * 10_000 + 9_000,
    };
}

function fix(overrides: Partial<ProposedFix> & { heard: string }): ProposedFix {
    return {
        turn: 0,
        replacement: "Orion",
        context: "",
        target: null,
        ...overrides,
    };
}

const none = new Set<string>();

describe("wholeWordSpans", () => {
    it("finds whole words only, any spacing matching", () => {
        expect(wholeWordSpans("Orionek a Orion", "Orion")).toEqual([
            { start: 10, end: 15 },
        ]);
        expect(wholeWordSpans("Blue  Harbor dnes", "Blue Harbor")).toEqual([
            { start: 0, end: 12 },
        ]);
        expect(wholeWordSpans("Tavesý a", "Tavesy")).toEqual([]);
    });
});

describe("planFixes", () => {
    it("places a fix where its words stand once in the turn", () => {
        const { planned, dropped } = planFixes(
            [fix({ heard: "Oryon", replacement: "Orion" })],
            { turns: [turn("Projekt Oryon běží.")], taken: [], knownIds: none },
        );
        expect(planned).toEqual([
            {
                turnIndex: 0,
                charStart: 8,
                charEnd: 13,
                heard: "Oryon",
                replacement: "Orion",
                target: null,
            },
        ]);
        expect(dropped).toEqual({});
    });

    it("picks one of several by the context, else drops it as ambiguous", () => {
        const turns = [turn("Ten byl dobrý a ten bil špatný.")];
        const picked = planFixes(
            [fix({ heard: "ten", replacement: "Ten", context: "" })],
            { turns, taken: [], knownIds: none },
        );
        expect(picked.dropped).toEqual({ unchanged: 1 });

        const ambiguous = planFixes(
            [
                fix({
                    heard: "byl",
                    replacement: "bil",
                    context: "",
                }),
                fix({ heard: "a", replacement: "ať", context: "" }),
            ],
            { turns: [turn("byl a byl")], taken: [], knownIds: none },
        );
        expect(ambiguous.dropped).toEqual({ ambiguous: 1 });
        expect(ambiguous.planned.map((p) => p.replacement)).toEqual(["ať"]);

        const withContext = planFixes(
            [fix({ heard: "byl", replacement: "bil", context: "a byl" })],
            { turns: [turn("byl a byl")], taken: [], knownIds: none },
        );
        expect(withContext.planned).toMatchObject([
            { charStart: 6, charEnd: 9 },
        ]);
    });

    it("spreads a thing's name to every place, never a person's", () => {
        const turns = [turn("Oryon a Boris", 0), turn("zase Oryon a Boris", 1)];
        const known = new Set(["e1", "p1"]);
        const { planned } = planFixes(
            [
                fix({
                    heard: "Oryon",
                    replacement: "Orion",
                    target: { entityId: "e1" },
                }),
                fix({
                    turn: 1,
                    heard: "Boris",
                    replacement: "Borek",
                    target: { personId: "p1" },
                }),
            ],
            { turns, taken: [], knownIds: known },
        );
        expect(
            planned.map((p) => [p.turnIndex, p.heard, p.replacement]),
        ).toEqual([
            [0, "Oryon", "Orion"],
            [1, "Oryon", "Orion"],
            [1, "Boris", "Borek"],
        ]);
    });

    it("points at nothing when the model named a record the pass may not", () => {
        const { planned } = planFixes(
            [
                fix({
                    heard: "Oryon",
                    replacement: "Orion",
                    target: { entityId: "elsewhere" },
                }),
            ],
            { turns: [turn("Oryon a Oryon")], taken: [], knownIds: none },
        );
        // Not a known thing: not spread, and two places are ambiguous.
        expect(planned).toEqual([]);
    });

    it("never writes over a correction or another fix", () => {
        const turns = [turn("Oryon dnes")];
        const { planned, dropped } = planFixes(
            [
                fix({ heard: "Oryon", replacement: "Orion" }),
                fix({ heard: "Oryon dnes", replacement: "Orion dnes" }),
            ],
            {
                turns,
                taken: [{ turnIndex: 0, charStart: 0, charEnd: 5 }],
                knownIds: none,
            },
        );
        expect(planned).toEqual([]);
        expect(dropped).toEqual({ overlapping: 2 });
    });

    it("drops long rewrites, unchanged words and missing places", () => {
        const { planned, dropped } = planFixes(
            [
                fix({
                    heard: "one two three four five six seven",
                    replacement: "x",
                }),
                fix({ heard: "Orion", replacement: "orion." }),
                fix({ heard: "nowhere", replacement: "somewhere" }),
                fix({ turn: 3, heard: "a", replacement: "b" }),
            ],
            {
                turns: [turn("one two three four five six seven Orion")],
                taken: [],
                knownIds: none,
            },
        );
        expect(planned).toEqual([]);
        expect(dropped).toEqual({
            too_long: 1,
            unchanged: 1,
            not_found: 1,
            no_turn: 1,
        });
    });

    it("stops at the limit", () => {
        const { planned, dropped } = planFixes(
            [
                fix({ heard: "a", replacement: "A1" }),
                fix({ heard: "b", replacement: "B1" }),
            ],
            { turns: [turn("a b")], taken: [], knownIds: none, limit: 1 },
        );
        expect(planned).toHaveLength(1);
        expect(dropped).toEqual({ over_limit: 1 });
    });
});

describe("runCorrectionPass", () => {
    const almanac = [
        {
            id: "e1",
            kind: "entity" as const,
            typeKey: "project",
            name: "Orion",
            aliases: ["Ori"],
            heardAs: ["Oryon"],
        },
    ];
    const answer = JSON.stringify({
        fixes: [
            {
                turn: 0,
                heard: "Oryon",
                replacement: "Orion",
                context: "",
                target: { entityId: "e1" },
            },
        ],
    });

    it("asks the bridge once, with the pass's token and the Almanac", async () => {
        const complete = vi.fn().mockResolvedValue(answer);
        const result = await runCorrectionPass({
            path: "bridge",
            bridge: { complete },
            chat: { complete: vi.fn() },
            token: "cp1.token",
            turns: [turn("Projekt Oryon")],
            language: "cs",
            almanac,
            corrected: [],
        });
        expect(result.fixes).toHaveLength(1);
        expect(complete).toHaveBeenCalledTimes(1);
        const request = complete.mock.calls[0]?.[0];
        expect(request.mcp).toEqual({
            token: "cp1.token",
            tools: ["find_entities", "get_entity", "find_facts"],
        });
        expect(request.user).toContain('"name":"Orion"');
        expect(request.user).toContain("[T0 00:00] speaker_0: Projekt Oryon");
    });

    it("repairs a bridge answer once, then gives up", async () => {
        const complete = vi
            .fn()
            .mockResolvedValueOnce("not json")
            .mockResolvedValueOnce("still not");
        await expect(
            runCorrectionPass({
                path: "bridge",
                bridge: { complete },
                chat: { complete: vi.fn() },
                token: "t",
                turns: [turn("x")],
                language: null,
                almanac: [],
                corrected: [],
            }),
        ).rejects.toBeInstanceOf(LearnOutputUnusable);
        expect(complete).toHaveBeenCalledTimes(2);
        expect(complete.mock.calls[1]?.[0].mcp).toBeNull();
    });

    it("reads a window at a time on the fallback, keeping each window's own fixes", async () => {
        const long = "slovo ".repeat(4_000).trim();
        const turns = [turn(long, 0), turn(long, 1), turn("Oryon", 2)];
        const complete = vi.fn(async (messages: { content: string }[]) => {
            const user = messages[1]?.content ?? "";
            // A window answers for a turn outside it too: dropped.
            return JSON.stringify({
                fixes: [
                    {
                        turn: 2,
                        heard: "Oryon",
                        replacement: "Orion",
                        context: "",
                        target: null,
                    },
                    ...(user.includes("[T0 ")
                        ? []
                        : [
                              {
                                  turn: 0,
                                  heard: "slovo",
                                  replacement: "slova",
                                  context: "",
                                  target: null,
                              },
                          ]),
                ],
            });
        });
        const result = await runCorrectionPass({
            path: "fallback",
            bridge: { complete: vi.fn() },
            chat: { complete },
            token: "t",
            turns,
            language: "cs",
            almanac,
            corrected: [
                {
                    turnIndex: 2,
                    charStart: 0,
                    charEnd: 5,
                    heard: "Oryon",
                    reads: "Orion",
                },
            ],
        });
        expect(result.windows).toBeGreaterThan(1);
        expect(result.fixes.every((f) => f.turn === 2)).toBe(true);
        const last = complete.mock.calls.at(-1)?.[0]?.[1]?.content ?? "";
        expect(last).toContain('"reads":"Orion"');
    });
});

describe("rendering a fix", () => {
    it("reads as its replacement for people and for the model", () => {
        const turns = [turn("Projekt Oryon")];
        const overlay = [
            {
                turnIndex: 0,
                charStart: 8,
                charEnd: 13,
                heard: "Oryon",
                kind: "fix" as const,
                replacement: "Orion",
                meaning: "Orion",
            },
        ];
        expect(renderTurnsForPeople(turns, overlay)[0]?.text).toBe(
            "Projekt Orion",
        );
        expect(renderTurnsForLlm(turns, overlay)[0]?.text).toBe(
            "Projekt Orion",
        );
    });
});
