"use client";

import { Mail, Play } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";

export interface TaskEvidence {
    itemId: string;
    itemKind: "audio" | "mail";
    startMs: number | null;
    text: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    } | null;
}

/** Opens the exact audio or mail passage that supports a task proposal. */
export function TaskEvidenceLink({
    evidence,
    quote,
    onPlay,
    onNavigate,
}: {
    evidence: TaskEvidence;
    quote?: string | null;
    onPlay?: (startMs: number) => void;
    onNavigate?: () => void;
}) {
    const i18n = useExtracted();
    const label =
        evidence.itemKind === "mail"
            ? i18n("Show evidence in mail")
            : i18n("Play evidence");
    const className =
        "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline";

    if (evidence.itemKind === "audio" && evidence.startMs !== null && onPlay) {
        return (
            <button
                type="button"
                className={className}
                title={quote ?? undefined}
                aria-label={label}
                onClick={() => onPlay(evidence.startMs as number)}
            >
                <Play className="size-3" aria-hidden="true" />
                {i18n("Where it was said")}
            </button>
        );
    }

    const query = new URLSearchParams({ recording: evidence.itemId });
    if (evidence.itemKind === "audio" && evidence.startMs !== null) {
        query.set("playFrom", String(evidence.startMs));
    }
    if (evidence.itemKind === "mail" && evidence.text) {
        query.set("evidenceSegment", String(evidence.text.segmentIndex));
        query.set("evidenceStart", String(evidence.text.charStart));
        query.set("evidenceEnd", String(evidence.text.charEnd));
    }
    return (
        <Link
            href={`/dashboard?${query.toString()}`}
            className={className}
            title={quote ?? undefined}
            aria-label={label}
            onClick={onNavigate}
        >
            {evidence.itemKind === "mail" ? (
                <Mail className="size-3" aria-hidden="true" />
            ) : (
                <Play className="size-3" aria-hidden="true" />
            )}
            {evidence.itemKind === "mail"
                ? i18n("Show in mail")
                : i18n("Where it was said")}
        </Link>
    );
}
