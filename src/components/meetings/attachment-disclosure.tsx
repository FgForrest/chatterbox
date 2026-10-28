"use client";

import { useExtracted, useFormatter } from "next-intl";
import type { AgendaCandidate } from "./types";

export function AttachmentAudience({
    audience,
}: {
    audience: AgendaCandidate["audience"] | undefined;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    if (!audience || (!audience.organization && !audience.users.length))
        return null;
    return (
        <span className="mt-1 block text-xs">
            {i18n(
                "Shared-folder audience: {names}. Publication follows the recording owner’s review.",
                {
                    names: audience.organization
                        ? i18n("Organization")
                        : format.list(
                              audience.users.map(
                                  (person) =>
                                      person.name ?? i18n("Unknown author"),
                              ),
                          ),
                },
            )}
        </span>
    );
}

export function AttachmentFilingNotice() {
    const i18n = useExtracted();
    return (
        <p className="text-xs text-muted-foreground">
            {i18n(
                "The recording will be filed into all of the agenda’s folders. Organization sharing may wait for the owner’s speaker review.",
            )}
        </p>
    );
}
