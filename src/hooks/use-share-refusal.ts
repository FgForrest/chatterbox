"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import {
    shareReviewHref,
    useShareProblemMessage,
} from "@/hooks/use-share-problem-message";
import type { ApiErrorBody } from "@/lib/api-errors";
import {
    isShareReviewProblem,
    type ShareGateProblem,
} from "@/lib/sharing/share-gate";

const SHARE_REQUIREMENTS_UNMET = "SHARE_REQUIREMENTS_UNMET";

/** Explain a refused share and offer to open the review when one is required. */
export function useShareRefusal() {
    const i18n = useExtracted();
    const problemMessage = useShareProblemMessage();
    return useCallback(
        (error: ApiErrorBody, itemId?: string) => {
            if (error.code !== SHARE_REQUIREMENTS_UNMET) return null;
            const problems = Array.isArray(error.details?.problems)
                ? (error.details.problems as ShareGateProblem[])
                : [];
            const known = problems.map(problemMessage).filter(Boolean);
            const review = problems.find(isShareReviewProblem);
            const href =
                itemId && review ? shareReviewHref(itemId, review) : null;
            return {
                message:
                    known.length > 0
                        ? `${i18n("Not shared.")} ${known.join(" ")}`
                        : error.error,
                action: href
                    ? {
                          label: i18n("Open recording to review"),
                          onClick: () => window.location.assign(href),
                      }
                    : undefined,
            };
        },
        [i18n, problemMessage],
    );
}
