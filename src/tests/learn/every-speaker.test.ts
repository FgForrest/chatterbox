import { describe, expect, it } from "vitest";
import type { LearnOutput } from "@/lib/learn/output";
import {
    isUnansweredSpeaker,
    isUnmentionedSpeaker,
    needsLearnReview,
} from "@/lib/learn/review-policy";
import { type LearnRunFrame, validateLearnOutput } from "@/lib/learn/validate";

const frame: LearnRunFrame = {
    revision: 0,
    currentRevision: 0,
    transcriptKey: "test-transcript@0",
    language: "en",
    provider: null,
    turns: [0, 1, 2, 3, 2].map((number, index) => ({
        speaker: `speaker_${number}`,
        startMs: index * 7000,
        endMs: (index + 1) * 7000,
        text: "Jitka Dvořáková has the draft ready for everyone to review in this meeting.",
    })),
    people: new Map([["p1", { name: "Jitka Dvořáková" }]]),
    entities: new Map(),
    relations: new Map(),
    answeredLabels: new Map([
        ["speaker_0", "p1"],
        ["speaker_1", null],
    ]),
    confirmedHeardAs: new Set(),
    knownFacts: new Map(),
    dismissed: new Set(),
};
const empty: LearnOutput = {
    newRecords: [],
    speakers: [],
    corrections: [],
    facts: [],
    relationPhrases: [],
};

describe("every speaker in Learn", () => {
    it("adds exactly one optional row per unmentioned, unanswered label", () => {
        const result = validateLearnOutput(empty, frame);
        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.payload)).toEqual(
            [2, 3].map((n) => ({
                label: `speaker_${n}`,
                personId: null,
                evidenceMs: [],
                reason: "",
                unmentioned: true,
            })),
        );
        expect(
            result.items.every(
                (item) =>
                    item.kind === "speaker" &&
                    item.preTicked === false &&
                    isUnmentionedSpeaker(item) &&
                    !needsLearnReview(item),
            ),
        ).toBe(true);
    });
    it.each([
        false,
        true,
    ])("does not duplicate a Learn speaker (guess: %s)", (guess) => {
        const output: LearnOutput = {
            ...empty,
            speakers: [
                {
                    label: "speaker_2",
                    personId: "p1",
                    evidence: ["00:14"],
                    reason: "A name was heard.",
                    ...(guess
                        ? {
                              guess: {
                                  confidence: 0.4,
                                  clues: ["almanac" as const],
                              },
                          }
                        : {}),
                },
            ],
        };
        const result = validateLearnOutput(output, {
            ...frame,
            answeredLabels: new Map([
                ["speaker_0", null],
                ["speaker_1", null],
            ]),
        });
        expect(result.items).toHaveLength(2);
        expect(
            result.items.filter(
                (item) =>
                    item.kind === "speaker" &&
                    item.payload.label === "speaker_2",
            ),
        ).toHaveLength(1);
        expect(result.items[0].payload).not.toHaveProperty("unmentioned");
    });
    it("retains Learn's nobody-known reason and its effect on review", () => {
        const result = validateLearnOutput(
            {
                ...empty,
                speakers: [
                    {
                        label: "speaker_2",
                        personId: null,
                        evidence: ["00:14"],
                        reason: "Nobody known.",
                    },
                ],
            },
            frame,
        );
        expect(result.items[0].payload).toMatchObject({
            reason: "Nobody known.",
        });
        expect(needsLearnReview(result.items[0])).toBe(true);
        expect(isUnansweredSpeaker(result.items[0])).toBe(true);
    });
    it("offers an untouched row again even if a previous run had its fingerprint", () => {
        const first = validateLearnOutput(empty, frame);
        const next = validateLearnOutput(empty, {
            ...frame,
            dismissed: new Set(first.items.map((item) => item.fingerprint)),
        });
        expect(next.items).toEqual(first.items);
    });
    it("does not add rows for mail participants or placeholder labels", () => {
        expect(
            validateLearnOutput(empty, { ...frame, kind: "mail" }).items,
        ).toEqual([]);
        expect(
            validateLearnOutput(empty, {
                ...frame,
                turns: [
                    { ...frame.turns[0], speaker: "speaker" },
                    { ...frame.turns[0], speaker: "" },
                ],
            }).items,
        ).toEqual([]);
    });
    it("counts a chosen person or unknown as an answer, not an untouched row", () => {
        const item = validateLearnOutput(empty, frame).items[0];
        expect(
            isUnansweredSpeaker({ ...item, choice: { personId: "p1" } }),
        ).toBe(false);
        expect(
            isUnansweredSpeaker({ ...item, choice: { unknown: true } }),
        ).toBe(false);
    });
});
