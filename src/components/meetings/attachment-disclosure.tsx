"use client";

import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
import { usePersonSharing } from "@/components/sharing/person-sharing";
import { getPasswordManagerAttributes } from "@/lib/password-manager";
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
                "The recording will be filed into the agenda’s folders you can file into. Organization sharing may wait for the owner’s speaker review.",
            )}
        </p>
    );
}

/** Load invitation consent for exactly one selected agenda and recording pair. */
export function useAttachmentShareChoice(
    agendaId: string,
    recordingId: string,
) {
    const enabled = usePersonSharing();
    const [offer, setOffer] = useState<{
        agendaId: string;
        recordingId: string;
        people: { id: string; name: string | null }[];
        checked: boolean;
    } | null>(null);
    useEffect(() => {
        setOffer(null);
        if (!enabled || !agendaId || !recordingId) return;
        const abort = new AbortController();
        void fetch(
            `/api/meetings/${encodeURIComponent(agendaId)}/recording-shares?recordingItemId=${encodeURIComponent(recordingId)}`,
            { signal: abort.signal },
        )
            .then(async (response) => {
                if (response.ok) {
                    const data = (await response.json()) as {
                        people: { id: string; name: string | null }[];
                    };
                    if (!abort.signal.aborted)
                        setOffer({
                            agendaId,
                            recordingId,
                            people: data.people,
                            checked: true,
                        });
                }
            })
            .catch(() => {});
        return () => abort.abort();
    }, [enabled, agendaId, recordingId]);
    const current =
        enabled &&
        offer?.agendaId === agendaId &&
        offer.recordingId === recordingId
            ? offer
            : null;
    const shown = !!current?.people.length;
    return {
        people: current?.people ?? [],
        shown,
        checked: current?.checked ?? true,
        shareRecording: shown && current?.checked === true,
        onChange: (checked: boolean) =>
            setOffer((value) =>
                value?.agendaId === agendaId &&
                value.recordingId === recordingId
                    ? { ...value, checked }
                    : value,
            ),
    };
}

/** Explicit recording invitation choice, shared by both attachment entry points. */
export function AttachmentShareChoice({
    choice,
}: {
    choice: ReturnType<typeof useAttachmentShareChoice>;
}) {
    const i18n = useExtracted();
    if (!choice.shown) return null;
    return (
        <label className="flex items-start gap-2 text-sm">
            <input
                type="checkbox"
                {...getPasswordManagerAttributes()}
                checked={choice.checked}
                onChange={(event) => choice.onChange(event.target.checked)}
            />
            <span>
                {i18n("Share the recording with these people too: {names}", {
                    names: choice.people
                        .map((person) => person.name ?? i18n("Someone"))
                        .join(", "),
                })}
                <span className="block text-xs text-muted-foreground">
                    {i18n("They will receive an invitation.")}
                </span>
            </span>
        </label>
    );
}
