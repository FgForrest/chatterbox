import { describe, expect, it, vi } from "vitest";
import { runCorrectionPass } from "@/lib/learn/correction-pass";
import { runBridgePass } from "@/lib/learn/run-bridge";
import { runFallbackPass } from "@/lib/learn/run-fallback";
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
    it("places agenda spellings after meeting names and respects the vocabulary cap", () => {
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
            "Acme",
        ]);
        expect(result).toHaveLength(500);
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
