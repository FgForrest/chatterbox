import { describe, expect, it, vi } from "vitest";
import { runCorrectionPass } from "@/lib/learn/correction-pass";
import { runBridgePass } from "@/lib/learn/run-bridge";
import { runFallbackPass } from "@/lib/learn/run-fallback";
import {
    agendaLearnEvent,
    agendaSpellingTerms,
} from "@/lib/meetings/pipeline-context";
import {
    mergeAgendaOutcomes,
    readAgendaOutcome,
} from "@/lib/meetings/summary-directive";
import { buildMergeInput, runMultiPassSummary } from "@/lib/summary/multi-pass";
import { parseSummaryPayload } from "@/lib/summary/payload";
import { mergeMeetingTerms } from "@/lib/transcription/meeting-terms";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));

const outcome = {
    covered: ["p1"],
    notCovered: ["p2"],
    unplanned: ["Other topic"],
};
const reply = (agendaOutcome = outcome) =>
    JSON.stringify({
        summary: "### Agenda\n\nCovered: Acme",
        keyPoints: [],
        actionItems: [],
        agendaOutcome,
    });
const turns = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Acme roadmap" },
];
const emptyLearn = JSON.stringify({
    newRecords: [],
    speakers: [],
    corrections: [],
    facts: [],
    relationPhrases: [],
});

describe("agenda outcome contract", () => {
    it("adds no agenda tokens to a no-agenda merge even if a pass invents the field", async () => {
        const runMerge = vi.fn(
            async (_input: string, _prompt: string) =>
                '{"summary":"Before","keyPoints":[]}',
        );
        await runMultiPassSummary({
            rounds: 2,
            runPass: async () => reply(),
            runMerge,
        });
        expect(runMerge.mock.calls[0]?.[0]).not.toContain('"agendaOutcome"');
    });
    it("parses a structured outcome even with tasks disabled", () => {
        expect(
            parseSummaryPayload(reply(), { tasksEnabled: false }).agendaOutcome,
        ).toEqual(outcome);
    });
    it.each([
        null,
        [],
        {},
        { covered: [5], notCovered: [], unplanned: [] },
        { covered: [], notCovered: [], unplanned: "topic" },
    ])("refuses malformed outcome %j", (value) => {
        expect(readAgendaOutcome(value)).toBeNull();
    });
    it("deduplicates ids, resolves covered/notCovered conflicts and trims text", () => {
        expect(
            readAgendaOutcome({
                covered: [" p1 ", "p1"],
                notCovered: ["p1", "p2"],
                unplanned: [" x ", "x", ""],
            }),
        ).toEqual({ covered: ["p1"], notCovered: ["p2"], unplanned: ["x"] });
    });
    it("unions coverage, derives its complement and deduplicates unplanned topics", () => {
        expect(
            mergeAgendaOutcomes(
                [
                    outcome,
                    {
                        covered: ["p2", "foreign"],
                        notCovered: ["p1"],
                        unplanned: ["OTHER   TOPIC", "New"],
                    },
                ],
                ["p1", "p2", "p3"],
            ),
        ).toEqual({
            covered: ["p1", "p2"],
            notCovered: ["p3"],
            unplanned: ["Other topic", "New"],
        });
    });
    it.each([
        true,
        false,
    ])("includes outcomes in merge inputs with tasks enabled=%s", (tasksEnabled) => {
        expect(
            buildMergeInput([parseSummaryPayload(reply())], tasksEnabled),
        ).toContain('"agendaOutcome"');
        expect(
            buildMergeInput(
                [parseSummaryPayload('{"summary":"Before"}')],
                tasksEnabled,
            ),
        ).not.toContain('"agendaOutcome"');
    });
    it.each([
        "success",
        "rejection",
        "unparseable",
    ])("keeps the pass union when merge is %s", async (mode) => {
        const runPass = vi
            .fn()
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(
                reply({
                    covered: ["p2"],
                    notCovered: ["p1", "p3"],
                    unplanned: ["other topic"],
                }),
            );
        const runMerge = vi.fn(async () => {
            if (mode === "rejection") throw new Error("Unavailable");
            return mode === "unparseable"
                ? "raw"
                : reply({
                      covered: ["p3"],
                      notCovered: ["p1", "p2"],
                      unplanned: ["invented"],
                  });
        });
        const result = await runMultiPassSummary({
            rounds: 2,
            runPass,
            runMerge,
            agendaPointIds: ["p1", "p2", "p3"],
        });
        expect(result.payload.agendaOutcome).toEqual({
            covered: ["p1", "p2"],
            notCovered: ["p3"],
            unplanned: ["Other topic"],
        });
    });
});

describe("agenda terms and Learn hints", () => {
    it("ranks agenda spellings after Almanac terms under the vocabulary cap", () => {
        const terms = [
            { text: "Recorder", soundsLike: [] },
            ...Array.from({ length: 500 }, (_, i) => ({
                text: `term${i}`,
                soundsLike: [],
            })),
        ];
        const result = mergeMeetingTerms(
            terms,
            [{ name: "Jitka Dvořáková", source: "calendar" }],
            "Recorder",
            ["Acme", "acme", "X".repeat(50)],
        );
        expect(result.slice(0, 3).map((term) => term.text)).toEqual([
            "Recorder",
            "Jitka Dvořáková",
            "term0",
        ]);
        expect(result).toHaveLength(500);
        expect(result.some((term) => term.text === "Acme")).toBe(false);
    });
    it.each([
        "bridge",
        "fallback",
    ] as const)("sends topic hints separately from evidence through %s", async (path) => {
        const agendaPlan =
            "Agenda (the plan, not evidence). Topic hint: Acme roadmap. Never infer facts from this plan.";
        const complete = vi.fn(async () => emptyLearn);
        if (path === "bridge") {
            await runBridgePass({
                chat: { complete },
                token: "test",
                turns,
                language: "en",
                relations: [],
                unnamedLabels: [],
                agendaPlan,
            });
            expect(complete.mock.calls[0]).toBeDefined();
        } else {
            complete.mockResolvedValueOnce('{"mentions":[]}');
            await runFallbackPass({
                chat: { complete },
                lookup: { findEntities: async () => ({ entities: [] }) },
                turns,
                language: "en",
                relations: [],
                unnamedLabels: [],
                agendaPlan,
            });
        }
        expect(JSON.stringify(complete.mock.calls)).toContain(
            "the plan, not evidence",
        );
        expect(JSON.stringify(complete.mock.calls)).toContain(
            "Never infer facts",
        );
    });
    it.each([
        "bridge",
        "fallback",
    ] as const)("labels agenda words as spelling-only in the %s correction pass", async (path) => {
        const complete = vi.fn(async () => '{"fixes":[]}');
        await runCorrectionPass({
            path,
            bridge: { complete },
            chat: { complete },
            token: "test",
            turns,
            language: "en",
            almanac: [],
            corrected: [],
            agendaTerms: ["Acme"],
        });
        const requests = JSON.stringify(complete.mock.calls);
        expect(requests).toContain("spelling only, plan never evidence");
        expect(requests).toContain("Never add planned content");
    });
});

it("filters Czech and English function words and caps agenda keyterms at 50", () => {
    const terms = agendaSpellingTerms({
        id: "agenda",
        userId: "owner",
        version: 0,
        calendarEventId: null,
        points: [
            {
                id: "point",
                parentId: null,
                position: 0,
                discussedAt: null,
                note: null,
                text: `je na pro při nebo the and with from Acme Dvořáková ${Array.from({ length: 100 }, (_, i) => `term${i}`).join(" ")}`,
            },
        ],
        tasks: [],
    });
    expect(terms.slice(0, 2)).toEqual(["Acme", "Dvořáková"]);
    expect(terms).toHaveLength(50);
    for (const word of [
        "je",
        "na",
        "pro",
        "při",
        "nebo",
        "the",
        "and",
        "with",
        "from",
    ])
        expect(terms).not.toContain(word);
});

it.each([
    ["chosen", "agenda", "stored", "chosen"],
    ["", "agenda", "stored", ""],
    [undefined, "agenda", "stored", "agenda"],
    [undefined, null, "stored", "stored"],
    [undefined, null, undefined, undefined],
])("Learn event precedence explicit=%s agenda=%s stored=%s", (explicit, agenda, stored, expected) => {
    expect(agendaLearnEvent(explicit, agenda, stored)).toBe(expected);
});
