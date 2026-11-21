"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import { itemDetailHref } from "@/lib/item-detail";
import type {
    ShareGateProblem,
    ShareReviewProblem,
} from "@/lib/sharing/share-gate";

/** Link to the relevant widget on the owner's recording page. */
export function shareReviewHref(
    itemId: string,
    problem: ShareReviewProblem,
): string {
    if (problem.kind === "learn_unfinished")
        return itemDetailHref(itemId, { widget: "learn" });
    return itemDetailHref(itemId, {
        widget: problem.waiting === "summary" ? "summary" : "tasks",
    });
}

/** Translate one reason an audio item is waiting to be shared. */
export function useShareProblemMessage() {
    const i18n = useExtracted();
    return useCallback(
        (problem: ShareGateProblem): string | null => {
            switch (problem.kind) {
                case "learn_unfinished":
                    return i18n("Finish Learn before sharing this recording.");
                case "tasks_unreviewed":
                    return problem.waiting === "summary"
                        ? i18n("Sharing waits for the summary.")
                        : i18n(
                              "Review the proposed tasks before sharing this recording.",
                          );
                case "no_transcript":
                    return i18n("Transcribe the recording before sharing it.");
                case "unresolved_speakers": {
                    const count = problem.labels.length;
                    return problem.source === "plaud"
                        ? i18n(
                              "{count, plural, one {# speaker is} other {# speakers are}} still unnamed in the Plaud transcript.",
                              { count },
                          )
                        : i18n(
                              "{count, plural, one {# speaker is} other {# speakers are}} still unnamed in the Custom transcript.",
                              { count },
                          );
                }
                default:
                    return null;
            }
        },
        [i18n],
    );
}
