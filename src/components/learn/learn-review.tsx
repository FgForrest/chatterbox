"use client";

import type { LearnMarks } from "@/components/learn/learn-marks";
import { LearnWidget } from "@/components/learn/learn-widget";
import type { WorkflowWidgetFrame } from "@/lib/pipeline/workflow-widgets";
import type { RecordingView } from "@/lib/sharing/view";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** Connect a recording transcript to the shared Learn widget. */
export function LearnReview({
    recordingId,
    view,
    source,
    turns,
    onSeek,
    onPlaySpeaker,
    onFinished,
    onMarks,
    pollMs,
    frame = "inline",
    widgetId,
    folderName,
    showTrigger = true,
    collapseReady = false,
}: {
    recordingId: string;
    view?: RecordingView;
    source: "plaud" | "riffado";
    turns: readonly TranscriptTurn[];
    onSeek?: (ms: number) => void;
    onPlaySpeaker?: (label: string) => boolean;
    onFinished?: () => void;
    onMarks?: (marks: LearnMarks | null) => void;
    pollMs?: number;
    frame?: WorkflowWidgetFrame;
    widgetId?: string;
    folderName?: string;
    showTrigger?: boolean;
    collapseReady?: boolean;
}) {
    return (
        <LearnWidget
            kind="audio"
            recordingId={recordingId}
            view={view}
            source={source}
            turns={turns}
            onSeek={onSeek}
            onPlaySpeaker={onPlaySpeaker}
            onFinished={onFinished}
            onMarks={onMarks}
            pollMs={pollMs}
            frame={frame}
            widgetId={widgetId}
            folderName={folderName}
            showTrigger={showTrigger}
            collapseReady={collapseReady}
        />
    );
}
