"use client";

import { AudioWaveform, Loader2 } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import type { ReactNode } from "react";
import { ItemHeader } from "@/components/items/item-header";
import { useDateTimeFormatter } from "@/hooks/use-date-time-formatter";
import { formatBytes } from "@/lib/format-bytes";
import { formatDuration } from "@/lib/format-duration";
import type { Recording } from "@/types/recording";

const NON_DEVICE_SOURCES = new Set(["local", "mail"]);

interface RecordingPlayerHeaderProps {
    recording: Recording;
    action?: ReactNode;
    onRenamed?: (filename: string) => void;
    /** Whether the item is shared into the Organization. */
    shared?: boolean;
    /**
     * Whether the viewer may rename it, when the caller knows better than
     * its ownership alone: Organization curators may rename shared items.
     */
    titleReadOnly?: boolean;
    onKnowledge?: () => void;
    knowledgeOpen?: boolean;
    pendingLearnCount?: number;
}

interface RecordingWaveformStatusProps {
    scrubberStyle: "waveform" | "slider";
    waveformStatus: "idle" | "ready" | "decoding" | "skipped" | "error";
    onDecodeWaveform: () => void;
}

/**
 * Recording identity and destructive actions sit outside the player card so
 * every artifact panel reads as a peer below the same page-level heading.
 */
export function RecordingPlayerHeader({
    recording,
    action,
    onRenamed,
    shared = false,
    titleReadOnly,
    onKnowledge,
    knowledgeOpen,
    pendingLearnCount,
}: RecordingPlayerHeaderProps) {
    const locale = useLocale();
    const formatDateTime = useDateTimeFormatter();
    const i18n = useExtracted();
    const metaParts: string[] = [
        formatDateTime(recording.startTime, "relative", locale),
        formatDuration(recording.duration / 1000),
        formatBytes(recording.filesize),
    ];
    if (recording.deviceSn && !NON_DEVICE_SOURCES.has(recording.deviceSn)) {
        metaParts.push(
            i18n("Device: {serial}", { serial: recording.deviceSn }),
        );
    }
    const retentionNotes = [
        recording.audioReapedAt
            ? i18n("The audio was removed on {date}.", {
                  date: formatDateTime(
                      recording.audioReapedAt,
                      "absolute",
                      locale,
                  ),
              })
            : null,
        recording.transcriptReapedAt
            ? i18n("Its transcript was removed on {date}.", {
                  date: formatDateTime(
                      recording.transcriptReapedAt,
                      "absolute",
                      locale,
                  ),
              })
            : null,
        recording.summaryReapedAt
            ? i18n("Its summary was removed on {date}.", {
                  date: formatDateTime(
                      recording.summaryReapedAt,
                      "absolute",
                      locale,
                  ),
              })
            : null,
    ].filter((note): note is string => note !== null);

    return (
        <ItemHeader
            itemId={recording.id}
            kind="audio"
            title={recording.filename}
            metadata={metaParts}
            view={recording.view}
            shared={shared}
            isOwn={recording.isOwn}
            ownerName={recording.ownerName}
            readOnly={titleReadOnly ?? recording.isOwn === false}
            onRenamed={onRenamed}
            action={action}
            onKnowledge={onKnowledge}
            knowledgeOpen={knowledgeOpen}
            pendingLearnCount={pendingLearnCount}
            retentionNotes={retentionNotes}
        />
    );
}

export function RecordingWaveformStatus({
    scrubberStyle,
    waveformStatus,
    onDecodeWaveform,
}: RecordingWaveformStatusProps) {
    const i18n = useExtracted();
    if (scrubberStyle !== "waveform" || waveformStatus === "ready") {
        return null;
    }

    return (
        <div className="flex min-h-5 items-center text-xs text-muted-foreground">
            {waveformStatus === "decoding" && (
                <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3 animate-spin" />{" "}
                    {i18n("Analyzing audio…")}
                </span>
            )}
            {waveformStatus === "skipped" && (
                <button
                    type="button"
                    onClick={onDecodeWaveform}
                    className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
                    title={i18n(
                        "Decode waveform in your browser (may take a few seconds)",
                    )}
                >
                    <AudioWaveform className="size-3" />{" "}
                    {i18n("Generate waveform")}
                </button>
            )}
            {waveformStatus === "error" && (
                <button
                    type="button"
                    onClick={onDecodeWaveform}
                    className="inline-flex items-center gap-1.5 text-destructive underline-offset-2 hover:underline"
                >
                    <AudioWaveform className="size-3" />{" "}
                    {i18n("Retry waveform")}
                </button>
            )}
            {waveformStatus === "idle" && (
                <span className="sr-only">
                    {i18n("Waveform is not available")}
                </span>
            )}
        </div>
    );
}
