"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

interface DueKind {
    kind: "audio" | "transcript" | "summary";
    days: number;
}

export interface WithdrawPreview {
    /** `loading` until the answer is in; confirming waits for it. */
    status: "loading" | "ready" | "failed";
    due: DueKind[];
}

/**
 * What the owner's own retention will delete once a shared recording is
 * withdrawn: while shared the Organization's policy kept it, and the
 * owner's applies again at its next sweep, within the hour. `recordingId`
 * null asks nothing (no confirmation open).
 */
export function useWithdrawPreview(
    recordingId: string | null,
    view: RecordingView = "private",
): WithdrawPreview {
    const [preview, setPreview] = useState<WithdrawPreview>({
        status: "loading",
        due: [],
    });

    useEffect(() => {
        if (!recordingId) return;
        let cancelled = false;
        setPreview({ status: "loading", due: [] });
        void fetch(
            withRecordingView(
                `/api/recordings/${recordingId}/withdraw-preview`,
                view,
            ),
        )
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                return (await response.json()) as { due?: DueKind[] };
            })
            .then((body) => {
                if (!cancelled) {
                    setPreview({ status: "ready", due: body.due ?? [] });
                }
            })
            .catch(() => {
                if (!cancelled) setPreview({ status: "failed", due: [] });
            });
        return () => {
            cancelled = true;
        };
    }, [recordingId, view]);

    return preview;
}

/**
 * The warning every confirmation that withdraws shows: what will be
 * deleted, that it is still being checked, or that it could not be.
 * `ofOwner`: told to the organization account, about the owner's
 * retention.
 */
export function WithdrawRetentionWarning({
    preview,
    ofOwner = false,
}: {
    preview: WithdrawPreview;
    ofOwner?: boolean;
}) {
    const i18n = useExtracted();
    if (preview.status === "loading") {
        return (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {ofOwner
                    ? i18n("Checking what the owner's retention will delete…")
                    : i18n("Checking what your retention will delete…")}
            </p>
        );
    }
    if (preview.status === "failed") {
        return (
            <div
                role="alert"
                className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                {ofOwner
                    ? i18n(
                          "Could not check what the owner's retention will delete. Once it is theirs again, their retention settings apply at once.",
                      )
                    : i18n(
                          "Could not check what your retention will delete. Once it is yours again, your retention settings apply at once.",
                      )}
            </div>
        );
    }
    if (preview.due.length === 0) return null;
    const line = ({ kind, days }: DueKind) => {
        if (ofOwner) {
            switch (kind) {
                case "audio":
                    return i18n(
                        "The owner's retention deletes audio older than {days, plural, one {# day} other {# days}}, so this recording's audio will be deleted within the hour.",
                        { days },
                    );
                case "transcript":
                    return i18n(
                        "The owner's retention deletes transcripts older than {days, plural, one {# day} other {# days}}, so this recording's transcripts will be deleted within the hour.",
                        { days },
                    );
                case "summary":
                    return i18n(
                        "The owner's retention deletes summaries older than {days, plural, one {# day} other {# days}}, so this recording's summaries will be deleted within the hour.",
                        { days },
                    );
            }
        }
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
                {preview.due.map((item) => (
                    <li key={item.kind}>{line(item)}</li>
                ))}
            </ul>
        </div>
    );
}
