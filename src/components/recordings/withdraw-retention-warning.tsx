"use client";

import { AlertTriangle } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";

interface DueKind {
    kind: "audio" | "transcript" | "summary";
    days: number;
}

/**
 * What the owner's own retention will delete once a shared recording is
 * withdrawn: while shared the Organization's policy kept it, and the
 * owner's applies again at its next sweep, within the hour. Shown in every
 * confirmation that withdraws; nothing when nothing is due.
 */
export function WithdrawRetentionWarning({
    recordingId,
}: {
    recordingId: string;
}) {
    const i18n = useExtracted();
    const [due, setDue] = useState<DueKind[]>([]);

    useEffect(() => {
        let cancelled = false;
        void fetch(`/api/recordings/${recordingId}/withdraw-preview`)
            .then((response) => (response.ok ? response.json() : null))
            .then((body: { due?: DueKind[] } | null) => {
                if (!cancelled) setDue(body?.due ?? []);
            })
            // A warning that could not be loaded is no reason to block the
            // withdrawal the person asked for.
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [recordingId]);

    if (due.length === 0) return null;
    const line = ({ kind, days }: DueKind) => {
        switch (kind) {
            case "audio":
                return i18n(
                    "Your retention deletes audio older than {days, plural, one {# day} other {# days}}, so this recording's audio will be deleted within the hour.",
                    { days },
                );
            case "transcript":
                return i18n(
                    "Your retention deletes transcripts older than {days, plural, one {# day} other {# days}}, so this recording's transcripts will be deleted within the hour.",
                    { days },
                );
            case "summary":
                return i18n(
                    "Your retention deletes summaries older than {days, plural, one {# day} other {# days}}, so this recording's summaries will be deleted within the hour.",
                    { days },
                );
        }
    };
    return (
        <div
            role="alert"
            className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <ul className="space-y-1">
                {due.map((item) => (
                    <li key={item.kind}>{line(item)}</li>
                ))}
            </ul>
        </div>
    );
}
