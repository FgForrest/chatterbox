"use client";

import { Mail, Pause, Play } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { TranscriptPlayback } from "@/hooks/use-transcript-follow";
import { formatClock } from "@/lib/topics/timeline";

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
    currentItemId,
    playback,
    showQuote = false,
}: {
    evidence: TaskEvidence;
    quote?: string | null;
    onPlay?: (startMs: number) => void;
    onNavigate?: () => void;
    currentItemId?: string;
    playback?: TranscriptPlayback;
    showQuote?: boolean;
}) {
    const i18n = useExtracted();
    const [playing, setPlaying] = useState(false);
    const startedHere = useRef(false);
    const requested = useRef(false);
    useEffect(() => {
        if (!playback) return;
        return playback.subscribe((state) => {
            if (state.playing && startedHere.current) {
                requested.current = false;
                setPlaying(true);
            } else if (
                !state.playing &&
                startedHere.current &&
                !requested.current
            ) {
                startedHere.current = false;
                setPlaying(false);
            }
        });
    }, [playback]);

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
        evidence.itemKind === "audio" &&
        evidence.startMs !== null &&
        evidence.itemId === currentItemId &&
        (onPlay !== undefined || playback !== undefined);
    const time =
        evidence.startMs === null ? null : formatClock(evidence.startMs);
    const audioLabel = playing
        ? i18n("Pause evidence at {time}", { time: time ?? "" })
        : i18n("Play evidence at {time}", { time: time ?? "" });
    let action: ReactNode;

    if (currentAudio) {
        action = (
            <button
                type="button"
                className={`${className} ${playing ? "text-primary" : ""}`}
                title={quote ?? undefined}
                aria-label={audioLabel}
                aria-pressed={playback ? playing : undefined}
                onClick={() => {
                    const startMs = evidence.startMs as number;
                    if (playback) {
                        if (playing) {
                            requested.current = false;
                            startedHere.current = false;
                            setPlaying(false);
                            playback.pause();
                        } else {
                            requested.current = true;
                            startedHere.current = true;
                            setPlaying(true);
                            playback.play(startMs);
                        }
                    } else {
                        onPlay?.(startMs);
                    }
                }}
            >
                {playing ? (
                    <Pause className="size-3" aria-hidden="true" />
                ) : (
                    <Play className="size-3" aria-hidden="true" />
                )}
                {time}
            </button>
        );
    } else {
        const query = new URLSearchParams({ recording: evidence.itemId });
        if (evidence.itemKind === "audio" && evidence.startMs !== null) {
            query.set("playFrom", String(evidence.startMs));
        }
        if (evidence.itemKind === "mail" && evidence.text) {
            query.set("evidenceSegment", String(evidence.text.segmentIndex));
            query.set("evidenceStart", String(evidence.text.charStart));
            query.set("evidenceEnd", String(evidence.text.charEnd));
        }
        const label =
            evidence.itemKind === "mail"
                ? i18n("Show evidence in mail")
                : audioLabel;
        action = (
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
                {evidence.itemKind === "mail" ? i18n("Show in mail") : time}
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
