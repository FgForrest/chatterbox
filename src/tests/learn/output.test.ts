import { describe, expect, it } from "vitest";
import {
    LEARN_LIMITS,
    learnOutputJsonSchema,
    parseLearnOutput,
} from "@/lib/learn/output";

const valid = {
    speakers: [
        {
            label: "speaker_1",
            personId: "p-jan",
            evidence: ["00:18", "04:12"],
            reason: "introduces himself as Jan from Tavesi",
        },
    ],
    corrections: [
        {
            turnIndex: 2,
            charStart: 10,
            charEnd: 16,
            heard: "Tavesy",
            kind: "correct",
            target: { entityId: "e-tavesi" },
            replacement: "Tavesi",
        },
        {
            turnIndex: 4,
            charStart: 0,
            charEnd: 5,
            heard: "Honza",
            kind: "link",
            target: { personId: "p-jan" },
            replacement: null,
        },
    ],
    facts: [
        {
            subject: { speakerLabel: "speaker_1" },
            relationKey: "leads",
            object: { entityId: "e-orion" },
            start: "12:04",
            end: "12:10",
            speakerLabel: "speaker_1",
            sensitivity: "none",
        },
        {
            subject: { personId: "p-jan" },
            relationKey: "has_role",
            object: { literal: "account manager" },
            start: "13:00",
            end: "13:05",
            speakerLabel: null,
            sensitivity: "none",
        },
    ],
    relationPhrases: [
        {
            phrase: "is account manager for",
            subject: { personId: "p-jan" },
            object: { entityId: "e-tavesi" },
            start: "13:00",
            end: "13:05",
        },
    ],
};

describe("Learn output", () => {
    it("parses a well-formed answer", () => {
        const parsed = parseLearnOutput(JSON.stringify(valid));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.output).toEqual(valid);
    });

    it("accepts an answer with nothing found", () => {
        expect(
            parseLearnOutput(
                '{"speakers":[],"corrections":[],"facts":[],"relationPhrases":[]}',
            ),
        ).toEqual({
            ok: true,
            output: {
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            },
        });
    });

    it("finds the JSON inside a fenced reply", () => {
        const parsed = parseLearnOutput(
            `Here it is:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
        );
        expect(parsed.ok).toBe(true);
    });

    it("refuses what is not the shape, saying where", () => {
        const wrongKind = structuredClone(valid) as unknown as {
            corrections: { kind: string }[];
        };
        wrongKind.corrections[0] = {
            ...wrongKind.corrections[0],
            kind: "rewrite",
        };
        const parsed = parseLearnOutput(JSON.stringify(wrongKind));
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toContain("corrections");
        expect(parseLearnOutput("not json at all").ok).toBe(false);
    });

    it("refuses a node naming two things, or a literal as a subject", () => {
        const two = structuredClone(valid) as unknown as {
            facts: Record<string, unknown>[];
        };
        two.facts[0] = {
            ...two.facts[0],
            subject: { personId: "p-jan", entityId: "e-orion" },
        };
        expect(parseLearnOutput(JSON.stringify(two)).ok).toBe(false);
        const literalSubject = structuredClone(valid) as unknown as {
            facts: Record<string, unknown>[];
        };
        literalSubject.facts[0] = {
            ...literalSubject.facts[0],
            subject: { literal: "someone" },
        };
        expect(parseLearnOutput(JSON.stringify(literalSubject)).ok).toBe(false);
    });

    it("bounds how much one answer may carry", () => {
        const many = structuredClone(valid) as unknown as {
            facts: unknown[];
        };
        many.facts = Array.from(
            { length: LEARN_LIMITS.facts + 1 },
            () => valid.facts[0],
        );
        expect(parseLearnOutput(JSON.stringify(many)).ok).toBe(false);
        const long = structuredClone(valid);
        long.corrections[0] = {
            ...long.corrections[0],
            replacement: "x".repeat(LEARN_LIMITS.text + 1),
        } as (typeof valid.corrections)[number];
        expect(parseLearnOutput(JSON.stringify(long)).ok).toBe(false);
    });

    it("exports a JSON Schema the CLIs can enforce", () => {
        const schema = learnOutputJsonSchema();
        expect(schema).toMatchObject({
            type: "object",
            required: expect.arrayContaining([
                "speakers",
                "corrections",
                "facts",
                "relationPhrases",
            ]),
        });
        expect(JSON.stringify(schema)).toContain('"sensitivity"');
    });
});
