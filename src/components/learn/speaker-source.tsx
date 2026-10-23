"use client";

import { useExtracted } from "next-intl";
import type { SpeakerProposalContext } from "@/lib/learn/output";

/** Localized provenance shared by the review and transcript suggestions. */
export function useSpeakerSource() {
    const i18n = useExtracted();
    return (context: SpeakerProposalContext & { reason?: string }): string => {
        const origin =
            context.source === "meet"
                ? i18n("Joined in Google Meet")
                : context.source === "calendar"
                  ? i18n("Invited in Calendar")
                  : context.guess
                    ? ""
                    : i18n("Named in the transcript");
        return [
            origin,
            context.guess?.matchedByEmail ? i18n("Matched by e-mail") : "",
            context.guess ? i18n("Guess") : "",
            context.reason,
        ]
            .filter(Boolean)
            .join(" · ");
    };
}
