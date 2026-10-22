import type { LearnOutput } from "@/lib/learn/output";
import { normalizeDetectedLanguage } from "@/lib/recordings/language";

export const LEARN_LANGUAGE_CONFIDENCE = 0.9;

export interface LanguageReviewCandidate {
    kind: "language";
    fingerprint: string;
    preTicked: true;
    payload: {
        language: string;
        detectedLanguage: string;
        confidence: number;
    };
}

/** A confident disagreement with the provider, only until a person has answered. */
export function learnLanguageCandidate(
    language: LearnOutput["language"],
    detected: string | null | undefined,
    confirmed?: string | null,
): LanguageReviewCandidate | null {
    const provider = normalizeDetectedLanguage(detected);
    const proposed = normalizeDetectedLanguage(language?.code);
    if (
        confirmed ||
        !language ||
        !provider ||
        !proposed ||
        proposed === provider ||
        !Number.isFinite(language.confidence) ||
        language.confidence > 1 ||
        language.confidence < LEARN_LANGUAGE_CONFIDENCE
    )
        return null;
    return {
        kind: "language",
        fingerprint: JSON.stringify(["language", provider, proposed]),
        preTicked: true,
        payload: {
            language: proposed,
            detectedLanguage: provider,
            confidence: language.confidence,
        },
    };
}

/** Character-weighted language confidence across every transcript window. */
export function joinLearnLanguages(
    votes: { language: LearnOutput["language"]; weight: number }[],
    totalWeight: number,
): LearnOutput["language"] {
    const totals = new Map<string, number>();
    for (const { language, weight } of votes) {
        if (!language) continue;
        totals.set(
            language.code,
            (totals.get(language.code) ?? 0) + weight * language.confidence,
        );
    }
    const best = [...totals].sort((a, b) => b[1] - a[1])[0];
    return best && totalWeight > 0
        ? { code: best[0], confidence: best[1] / totalWeight }
        : null;
}

export const LEARN_LANGUAGE_RULE =
    "language: identify the predominant language the transcript TEXT is actually written in, independently of the provider's language hint. Return its ISO 639-1 two-letter code and confidence from 0 to 1, or null when uncertain. Read the words themselves; a provider's hint may be wrong, particularly on short recordings.";
