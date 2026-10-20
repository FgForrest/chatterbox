import { describe, expect, it, vi } from "vitest";
import type { AppLocale } from "@/lib/i18n/config";
import { runCorrectionPass } from "@/lib/learn/correction-pass";
import { learnReviewLanguageRule } from "@/lib/learn/review-language";
import { type LearnBridgeChat, runBridgePass } from "@/lib/learn/run-bridge";
import { type LearnChat, runFallbackPass } from "@/lib/learn/run-fallback";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const turns: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Jan Novák works on the Oryon service in Prague.",
    },
];

const output = {
    newRecords: [
        {
            ref: "n1",
            kind: "entity",
            typeKey: "project",
            name: "Orion",
            speakerLabel: null,
            evidence: ["00:00"],
            reason: "Název služby uvedený ve zdroji.",
        },
    ],
    speakers: [
        {
            label: "speaker_0",
            personId: "p1",
            evidence: ["00:00"],
            reason: "Mluvčí se představil jménem.",
        },
    ],
    corrections: [],
    facts: [
        {
            subject: { personId: "p1" },
            relationKey: "title",
            object: { literal: "service lead" },
            start: "00:00",
            end: "00:00",
            speakerLabel: null,
            sensitivity: "none",
        },
    ],
    relationPhrases: [
        {
            phrase: "works on",
            subject: { personId: "p1" },
            object: { newRef: "n1" },
            start: "00:00",
            end: "00:00",
            sensitivity: "none",
        },
    ],
};

const fixes = [
    {
        turn: 0,
        heard: "Oryon",
        replacement: "Orion",
        context: "the Oryon service",
        target: { entityId: "e1" },
    },
];

const paths = [
    "bridge",
    "fallback",
    "mail",
    "correction-bridge",
    "correction-fallback",
] as const;
type Path = (typeof paths)[number];

async function capturePrompts(path: Path, reviewLocale?: AppLocale | null) {
    const requests: { system: string; user: string }[] = [];
    const answer = JSON.stringify(
        path.startsWith("correction") ? { fixes } : output,
    );
    let attempts = 0;
    const reply = () => (++attempts === 1 ? "not JSON" : answer);
    const bridge: LearnBridgeChat = {
        complete: vi.fn<LearnBridgeChat["complete"]>(async (request) => {
            requests.push({ system: request.system, user: request.user });
            return reply();
        }),
    };
    const chat: LearnChat = {
        complete: vi.fn<LearnChat["complete"]>(async (messages) => {
            const system = messages[0]?.content ?? "";
            requests.push({
                system,
                user: messages
                    .slice(1)
                    .map((message) => message.content)
                    .join("\n"),
            });
            return system.includes('"mentions"')
                ? JSON.stringify({ mentions: [] })
                : reply();
        }),
    };
    const input = {
        turns,
        language: "en",
        reviewLocale,
        relations: [],
        entityTypes: [{ key: "project", label: "Project" }],
        unnamedLabels: ["speaker_0"],
        recorder: { personId: "p1", name: "Jan Novák" },
    };
    if (path === "bridge") {
        return {
            requests,
            result: await runBridgePass({ ...input, chat: bridge, token: "t" }),
        };
    }
    if (path === "fallback" || path === "mail") {
        return {
            requests,
            result: await runFallbackPass({
                ...input,
                chat,
                lookup: { findEntities: async () => ({ entities: [] }) },
                framing: path === "mail" ? "mail" : "transcript",
            }),
        };
    }
    return {
        requests,
        result: await runCorrectionPass({
            ...input,
            path: path === "correction-bridge" ? "bridge" : "fallback",
            bridge,
            chat,
            token: "t",
            almanac: [],
            corrected: [],
        }),
    };
}

describe.each(paths)("Learn review language: %s", (path) => {
    it.each([
        ["cs-CZ", "Czech"],
        ["en", "English"],
        [undefined, "English"],
        [null, "English"],
    ] as const)("names %s as %s in generation and repair", async (locale, language) => {
        const { requests, result } = await capturePrompts(path, locale);
        const generation = requests.filter(
            (request) => !request.system.includes('"mentions"'),
        );
        expect(generation).toHaveLength(2);
        for (const request of generation) {
            expect(request.system).toContain(
                `Write all reviewer-facing reasons, explanations and other notes in ${language};`,
            );
            expect(request.system).toContain(
                "keep source names, quotes, values, correction replacements and relation phrases in the source language",
            );
            expect(request.system).toContain(
                "keep keys and identifiers unchanged",
            );
            expect(request.system).toContain(
                `write speakers[].reason and newRecords[].reason in ${language}, including reasons for unresolved speakers with personId null`,
            );
            expect(request.system).toContain(
                `check every reason and translate any explanation that is not in ${language}`,
            );
            expect(request.system).toContain(
                "On repair, preserve the proposed content but correct the language of reviewer-facing prose as well as the JSON shape",
            );
            expect(request.system).not.toContain("fix only its shape");
        }
        expect(generation[0]?.user).toContain(turns[0]?.text);
        expect(result.repairs).toBe(1);
        if ("output" in result) {
            expect(result.output.newRecords[0]).toMatchObject({
                name: "Orion",
                reason: output.newRecords[0]?.reason,
            });
            expect(result.output.facts).toEqual(output.facts);
            expect(result.output.relationPhrases[0]?.phrase).toBe("works on");
            if (path !== "mail")
                expect(result.output.speakers).toEqual(output.speakers);
            expect(generation[0]?.system).toContain(
                path === "mail"
                    ? "as a short phrase in the mail's language"
                    : "as a short phrase in the transcript's language",
            );
        } else {
            expect(result.fixes).toEqual(fixes);
            expect(generation[0]?.system).toContain("never translate");
            expect(generation[0]?.system).toContain(
                "in the transcript's language",
            );
        }
    });

    it("changes only the language instruction, preserving source and lookup prompts", async () => {
        const czech = await capturePrompts(path, "cs-CZ");
        const english = await capturePrompts(path, "en");
        expect(
            czech.requests.map((request) => ({
                ...request,
                system: request.system.replace(
                    learnReviewLanguageRule("cs-CZ"),
                    learnReviewLanguageRule("en"),
                ),
            })),
        ).toEqual(english.requests);
    });
});
