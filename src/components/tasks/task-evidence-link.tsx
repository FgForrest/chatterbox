"use client";

import { ArrowUpRight, Mail } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import { PlayAtButton } from "@/components/playback/play-at-button";
import { formatClock } from "@/lib/topics/timeline";

export interface TaskEvidence {
    itemId: string;
    itemKind: "audio" | "mail";
    audioAvailable: boolean;
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
    onNavigate,
    currentItemId,
    showQuote = false,
}: {
    evidence: TaskEvidence;
    quote?: string | null;
    onNavigate?: () => void;
    currentItemId?: string;
    showQuote?: boolean;
}) {
    const i18n = useExtracted();
    const className =
        "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline";
    const hasLocation = evidence.startMs !== null || evidence.text !== null;

    if (!hasLocation) {
        return (
            <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                {quote && (
                    <span className="min-w-0 italic text-muted-foreground">
                        “{quote}”
                    </span>
                )}
                <span className="text-muted-foreground/80">
                    {i18n("not found in the transcript")}
                </span>
            </span>
        );
    }

    const currentAudio =
        evidence.itemKind === "audio" && evidence.itemId === currentItemId;
    const time =
        evidence.startMs === null ? null : formatClock(evidence.startMs);
    let action: ReactNode;

    if (currentAudio) {
        if (evidence.startMs === null) {
            action = null;
        } else if (evidence.audioAvailable) {
            action = (
                <PlayAtButton
                    ms={evidence.startMs}
                    title={quote ?? undefined}
                />
            );
        } else {
            action = (
                <span
                    className="text-xs tabular-nums text-muted-foreground"
                    title={quote ?? undefined}
                >
                    {time}
                </span>
            );
        }
    } else {
        const query = new URLSearchParams({ recording: evidence.itemId });
        if (
            evidence.itemKind === "audio" &&
            evidence.audioAvailable &&
            evidence.startMs !== null
        ) {
            query.set("playFrom", String(evidence.startMs));
        }
        if (evidence.itemKind === "mail" && evidence.text) {
            query.set("evidenceSegment", String(evidence.text.segmentIndex));
            query.set("evidenceStart", String(evidence.text.charStart));
            query.set("evidenceEnd", String(evidence.text.charEnd));
        }
        let label = i18n("Show in recording");
        let text = label;
        let icon = <ArrowUpRight className="size-3" aria-hidden="true" />;
        if (evidence.itemKind === "mail") {
            label = i18n("Show evidence in mail");
            text = i18n("Show in mail");
            icon = <Mail className="size-3" aria-hidden="true" />;
        } else if (evidence.audioAvailable && time !== null) {
            text = time;
        }
        action = (
            <Link
                href={`/dashboard?${query.toString()}`}
                className={className}
                title={quote ?? undefined}
                aria-label={label}
                onClick={onNavigate}
            >
                {icon}
                {text}
            </Link>
        );
    }

    if (!showQuote || !quote) return action;
    return (
        <span className="inline-flex min-w-0 flex-col items-start gap-1">
            <span className="min-w-0 italic text-muted-foreground">
                “{quote}”
            </span>
            {action}
        </span>
    );
}
