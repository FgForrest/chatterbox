"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import type { ApiErrorBody } from "@/lib/api-errors";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";

const SHARE_REQUIREMENTS_UNMET = "SHARE_REQUIREMENTS_UNMET";

/**
 * Words for a refused share: what the recording still needs, from the
 * problems the server listed. Null when the error is not a refused share.
 */
export function useShareRefusal(): (error: ApiErrorBody) => string | null {
    const i18n = useExtracted();
    return useCallback(
        (error: ApiErrorBody) => {
            if (error.code !== SHARE_REQUIREMENTS_UNMET) return null;
            const problems = Array.isArray(error.details?.problems)
                ? (error.details.problems as ShareGateProblem[])
                : [];
            const sentences = problems.map((problem) => {
                switch (problem.kind) {
                    case "no_transcript":
                        return i18n(
                            "Transcribe the recording before sharing it.",
                        );
                    case "unresolved_speakers": {
                        const count = problem.labels.length;
                        return problem.source === "plaud"
                            ? i18n(
                                  "{count, plural, one {# speaker is} other {# speakers are}} still unnamed in the Plaud transcript.",
                                  { count },
                              )
                            : problem.source === "mixed"
                              ? i18n(
                                    "{count, plural, one {# speaker is} other {# speakers are}} still unnamed in the Mix transcript.",
                                    { count },
                                )
                              : i18n(
                                    "{count, plural, one {# speaker is} other {# speakers are}} still unnamed in the Custom transcript.",
                                    { count },
                                );
                    }
                    case "learn_unfinished":
                        return i18n(
                            "Finish reviewing what Learn found before sharing.",
                        );
                    case "tasks_unreviewed":
                        return i18n(
                            "Accept or reject the proposed tasks before sharing.",
                        );
                    default:
                        return null;
                }
            });
            const known = sentences.filter(
                (sentence): sentence is string => sentence !== null,
            );
            return known.length > 0
                ? `${i18n("Not shared.")} ${known.join(" ")}`
                : error.error;
        },
        [i18n],
    );
}
