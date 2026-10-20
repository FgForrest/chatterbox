import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
    type LearnOutput,
    learnOutputJsonSchema,
    learnOutputSchema,
} from "@/lib/learn/output";
import {
    type LearnProseRequest,
    learnReviewProse,
    repairLearnReviewProse,
    wrongLearnReviewLanguage,
} from "@/lib/learn/review-prose";
import { type LearnBridgeChat, runBridgePass } from "@/lib/learn/run-bridge";
import { type LearnChat, runFallbackPass } from "@/lib/learn/run-fallback";

const english =
    "The label speaks extensively and addresses Mr. Dvořák, but the transcript does not directly establish the speaker's own name. Knowledge base lookup was unavailable.";
const czech =
    "Mluvčí se v nahrávce nepředstavil a jeho jméno není možné spolehlivě určit.";

function output(): LearnOutput {
    return {
        speakers: [
            {
                label: "speaker_0",
                personId: null,
                evidence: ["00:00"],
                reason: english,
            },
        ],
        newRecords: [
            {
                ref: "n1",
                kind: "person",
                name: "Jane Smith",
                typeKey: null,
                speakerLabel: null,
                evidence: ["00:00"],
                reason: "The person is named in the meeting transcript.",
            },
        ],
        facts: [
            {
                subject: { newRef: "n1" },
                relationKey: "has_role",
                object: { literal: "The director of the company" },
                start: "00:00",
                end: "00:00",
                speakerLabel: null,
                sensitivity: "none",
            },
        ],
        corrections: [
            {
                turnIndex: 0,
                charStart: 0,
                charEnd: 4,
                heard: "Jane",
                kind: "correct",
                target: { newRef: "n1" },
                replacement: "Jane Smith",
            },
        ],
        relationPhrases: [
            {
                phrase: "is the director of",
                subject: { newRef: "n1" },
                object: { literal: "The company in the transcript" },
                start: "00:00",
                end: "00:00",
                sensitivity: "none",
            },
        ],
    };
}

const translation = () =>
    JSON.stringify({
        translations: [
            { index: 1, text: czech },
            {
                index: 0,
                text: "Tato osoba je v nahrávce uvedena celým jménem a je účastnicí schůzky.",
            },
        ],
    });

describe("Learn prose language post-check", () => {
    it.each([
        english,
        "The label adds technical details and is addressed as Jitka at 15:10, but there is no direct response confirming that name. Knowledge base lookup was unavailable.",
        "The label explains the application behavior and is addressed as Ondřej Malý at 32:06, but does not directly confirm that name. Knowledge base lookup was unavailable.",
        "Knowledge base lookup was unavailable.",
        "The speaker is unknown.",
    ])("detects English despite Czech names: %s", (text) => {
        expect(wrongLearnReviewLanguage(text, "cs-CZ")).toBe(true);
    });

    it("translates only mismatched prose, preserving every proposal, id, name, quote and value", async () => {
        const original = output();
        const before = structuredClone(original);
        const complete = vi.fn(async (_request: LearnProseRequest) =>
            translation(),
        );
        const result = await repairLearnReviewProse(
            original,
            "cs-CZ",
            complete,
        );
        expect(complete).toHaveBeenCalledOnce();
        expect(original).toEqual(before);
        expect(result).toEqual({
            ...before,
            speakers: [{ ...before.speakers[0], reason: czech }],
            newRecords: [
                {
                    ...before.newRecords[0],
                    reason: "Tato osoba je v nahrávce uvedena celým jménem a je účastnicí schůzky.",
                },
            ],
        });
        const request = complete.mock.calls[0]?.[0];
        expect(JSON.parse(request?.user ?? "{}")).toEqual(
            learnReviewProse(original).map((field, index) => ({
                index,
                text: field.text,
            })),
        );
        expect(request?.system).toContain(
            "Write all reviewer-facing reasons, explanations and other notes in Czech;",
        );
        expect(request?.system).toContain(
            '{"translations":[{"index":0,"text":"translated explanation"}]}',
        );
        expect(request?.user).not.toContain("Jane Smith");
    });

    it("makes no call for Czech, empty, or uncertain prose, nor for an English reviewer", async () => {
        const complete = vi.fn(async () => translation());
        for (const text of [
            czech,
            "Mluvčí se představil jménem.",
            "",
            "Jan Novák",
        ]) {
            const original = output();
            original.speakers[0].reason = text;
            original.newRecords[0].reason = text;
            expect(
                await repairLearnReviewProse(original, "cs-CZ", complete),
            ).toBe(original);
        }
        for (const locale of ["en", null, undefined] as const) {
            const original = output();
            expect(
                await repairLearnReviewProse(original, locale, complete),
            ).toBe(original);
        }
        expect(complete).not.toHaveBeenCalled();
    });

    it.each([
        "invalid JSON",
        JSON.stringify({ translations: [{ index: 0, text: english }] }),
        JSON.stringify({ translations: [{ index: 0, text: "Jan Novák" }] }),
        JSON.stringify({
            translations: [{ index: 0, text: czech, personId: "changed" }],
        }),
    ])("keeps all proposals when translation is unusable: %s", async (reply) => {
        const original = output();
        const complete = vi.fn(async () => reply);
        expect(
            await repairLearnReviewProse(original, "cs-CZ", complete),
        ).toEqual(original);
        expect(complete).toHaveBeenCalledOnce();
    });

    it("keeps proposals on a provider failure and never retries", async () => {
        const original = output();
        const complete = vi.fn(async () => {
            throw new Error("provider offline");
        });
        expect(await repairLearnReviewProse(original, "cs-CZ", complete)).toBe(
            original,
        );
        expect(complete).toHaveBeenCalledOnce();
    });

    it("ignores duplicate and unknown indexes, and cannot patch a correctly localized field", async () => {
        const original = output();
        original.newRecords[0].reason = czech;
        const complete = vi.fn(async () =>
            JSON.stringify({
                translations: [
                    { index: 0, text: czech },
                    { index: 0, text: czech },
                    { index: 1, text: czech },
                    { index: 100, text: czech },
                ],
            }),
        );
        expect(
            await repairLearnReviewProse(original, "cs-CZ", complete),
        ).toEqual(original);
    });

    it.each([
        "bridge",
        "fallback",
        "mail",
    ] as const)("checks %s after JSON repair, with one translation for all windows", async (path) => {
        const turns = [0, 1].map((index) => ({
            speaker: `speaker_${index}`,
            startMs: index * 1_000,
            endMs: index * 1_000 + 1_000,
            text: "Jane Smith is the director of the company.",
        }));
        let needsShapeRepair = true;
        const reply = (system: string, user: string) => {
            if (system.includes('"mentions"'))
                return JSON.stringify({ mentions: [] });
            if (system.includes("Translate only the supplied explanations")) {
                const fields = JSON.parse(user) as {
                    index: number;
                    text: string;
                }[];
                return JSON.stringify({
                    translations: fields.map(({ index }) => ({
                        index,
                        text: czech,
                    })),
                });
            }
            if (needsShapeRepair) {
                needsShapeRepair = false;
                return "not JSON";
            }
            return JSON.stringify(output());
        };
        const bridge: LearnBridgeChat = {
            complete: vi.fn(async (request) =>
                reply(request.system, request.user),
            ),
        };
        const chat: LearnChat = {
            complete: vi.fn(async (messages) =>
                reply(messages[0].content, messages[1].content),
            ),
        };
        const input = {
            reviewLocale: "cs-CZ" as const,
            turns,
            language: "en",
            relations: [],
            unnamedLabels: ["speaker_0"],
        };
        const result =
            path === "bridge"
                ? await runBridgePass({
                      ...input,
                      chat: bridge,
                      token: "token",
                  })
                : await runFallbackPass({
                      ...input,
                      chat,
                      lookup: { findEntities: async () => ({ entities: [] }) },
                      framing: path === "mail" ? "mail" : "transcript",
                      windowChars: 1,
                  });
        expect(result.repairs).toBe(2);
        expect(result.failedWindows).toBe(0);
        expect(
            learnReviewProse(result.output).every(
                (field) => field.text === czech,
            ),
        ).toBe(true);
        if (path === "bridge") {
            const requests = vi
                .mocked(bridge.complete)
                .mock.calls.map(([request]) => request);
            expect(requests).toHaveLength(result.calls);
            expect(requests.at(-1)?.mcp).toBeNull();
            expect(requests.at(-1)?.user).not.toContain("TRANSCRIPT");
        } else {
            const calls = vi.mocked(chat.complete).mock.calls;
            expect(calls).toHaveLength(result.calls);
            expect(
                calls.filter(([messages]) =>
                    messages[0].content.includes(
                        "Translate only the supplied explanations",
                    ),
                ),
            ).toHaveLength(1);
            expect(calls.at(-1)?.[2]).toEqual({ retry: false });
        }
    });

    it("requires a language classification for every new free-text schema field", () => {
        const visit = (value: unknown, path: string) => {
            if (!value || typeof value !== "object") return;
            const node = value as Record<string, unknown>;
            if (
                (node.type === "string" ||
                    (Array.isArray(node.type) &&
                        node.type.includes("string"))) &&
                !node.enum
            ) {
                expect(["reviewer", "source", "identifier"], path).toContain(
                    node.learnText,
                );
                if (/(reason|note|explanation)$/i.test(path))
                    expect(node.learnText, path).toBe("reviewer");
            }
            for (const [key, child] of Object.entries(node)) {
                if (child && typeof child === "object")
                    visit(
                        child,
                        key === "items" || key === "properties"
                            ? path
                            : `${path}.${key}`,
                    );
            }
        };
        visit(z.toJSONSchema(learnOutputSchema), "output");
        expect(JSON.stringify(learnOutputJsonSchema())).not.toContain(
            "learnText",
        );
    });
});
