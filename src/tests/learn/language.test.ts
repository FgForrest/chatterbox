import { describe, expect, it, vi } from "vitest";
import {
    joinLearnLanguages,
    learnLanguageCandidate,
} from "@/lib/learn/language";
import { mailCandidates } from "@/lib/learn/mail-candidates";
import { parseLearnOutput } from "@/lib/learn/output";
import {
    normalizeDetectedLanguage,
    recordingLanguage,
    recordingOutputLanguage,
} from "@/lib/recordings/language";

vi.mock("@/lib/env", () => ({
    env: { MAIL_DOMAIN: "example.test", SELF_HOST_MODE: "shared" },
}));

describe("confirmed recording language", () => {
    it.each([
        "hun",
        "hu",
        "hu-HU",
        "Hungarian",
    ])("compares normalized provider %s against Learn", (detected) => {
        expect(
            learnLanguageCandidate({ code: "cs", confidence: 0.95 }, detected),
        ).toMatchObject({
            kind: "language",
            preTicked: true,
            payload: { language: "cs", detectedLanguage: "hu" },
        });
    });
    it.each([
        "ces",
        "cze",
        "cs-CZ",
        "Czech",
    ])("agreement with %s stays silent", (detected) => {
        expect(
            learnLanguageCandidate({ code: "cs", confidence: 1 }, detected),
        ).toBeNull();
    });
    it.each(["cs-CZ", "CS", "ces"])("normalizes Learn code %s", (code) => {
        expect(
            learnLanguageCandidate({ code, confidence: 0.95 }, "hun")?.payload
                .language,
        ).toBe("cs");
    });
    it.each([
        1.01,
        95,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])("ignores invalid confidence %s", (confidence) => {
        expect(
            learnLanguageCandidate({ code: "cs", confidence }, "hun"),
        ).toBeNull();
    });
    it("ignores low confidence, unknown codes and an already confirmed choice", () => {
        expect(
            learnLanguageCandidate({ code: "cs", confidence: 0.89 }, "hun"),
        ).toBeNull();
        expect(
            learnLanguageCandidate({ code: "xx", confidence: 1 }, "hun"),
        ).toBeNull();
        expect(
            learnLanguageCandidate({ code: "cs", confidence: 1 }, null),
        ).toBeNull();
        expect(
            learnLanguageCandidate({ code: "cs", confidence: 1 }, "hun", "hu"),
        ).toBeNull();
        expect(recordingLanguage("auto")).toBeNull();
        expect(normalizeDetectedLanguage("auto")).toBeNull();
    });
    it("does not pass an audio language item to mail review", () => {
        const candidate = learnLanguageCandidate(
            { code: "cs", confidence: 1 },
            "hun",
        );
        expect(candidate).not.toBeNull();
        expect(mailCandidates(candidate ? [candidate] : [], [], [])).toEqual(
            [],
        );
    });
    it("requires the whole transcript to support a confident window result", () => {
        expect(
            joinLearnLanguages(
                [
                    { language: { code: "cs", confidence: 0.95 }, weight: 90 },
                    { language: { code: "hu", confidence: 0.95 }, weight: 10 },
                ],
                100,
            )?.confidence,
        ).toBeLessThan(0.9);
        expect(
            joinLearnLanguages(
                [{ language: { code: "cs", confidence: 0.95 }, weight: 100 }],
                100,
            ),
        ).toEqual({ code: "cs", confidence: 0.95 });
    });
    it.each([
        ["en", "cs", "en"],
        ["auto", "cs", "cs"],
        [null, "cs", "cs"],
        ["auto", null, null],
        [null, null, null],
    ])("resolves explicit %s and confirmed %s to %s", (explicit, confirmed, expected) => {
        expect(recordingOutputLanguage(explicit, confirmed)).toBe(expected);
    });
    it("validates the independent output field without changing old answers", () => {
        const base = {
            speakers: [],
            corrections: [],
            facts: [],
            relationPhrases: [],
        };
        expect(
            parseLearnOutput(
                JSON.stringify({
                    ...base,
                    language: { code: "cs", confidence: 0.95 },
                }),
            ).ok,
        ).toBe(true);
        expect(
            parseLearnOutput(
                JSON.stringify({
                    ...base,
                    language: { code: "ces", confidence: 0.95 },
                }),
            ).ok,
        ).toBe(true);
        expect(
            parseLearnOutput(
                JSON.stringify({
                    ...base,
                    language: { code: "cs", confidence: 2 },
                }),
            ).ok,
        ).toBe(true);
        expect(parseLearnOutput(JSON.stringify(base)).ok).toBe(true);
    });
});
