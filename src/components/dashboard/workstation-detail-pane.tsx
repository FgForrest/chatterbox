"use client";

import { ArrowLeft } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
    transcriptPlayback,
} from "@/components/dashboard/recording-player";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import { openWidget } from "@/components/pipeline/workflow-widget";
import { PlaybackProvider } from "@/components/playback/playback-context";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { hasAudio } from "@/lib/recordings/audio-availability";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { cn } from "@/lib/utils";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    language?: string;
    source?: string;
    provider?: string;
    model?: string;
    turns?: TranscriptTurn[] | null;
    topics?: TranscriptOption["topics"];
}

interface Props {
    currentRecording: Recording | null;
    itemLinkQuery?: string;
    currentTranscription: TranscriptionData | undefined;
    transcripts: TranscriptOption[] | undefined;
    isCurrentTranscribing: boolean;
    visibleRecordings: Recording[];
    onTranscribe: (attributionSource?: string, retranscribe?: boolean) => void;
    /** Called after a browser-side transcription completes (refresh data). */
    onTranscribeComplete?: () => void;
    /** Reload the page's transcripts; see `TranscriptionPanel`. */
    onTranscriptStale?: () => void;
    onFolderCreated?: (folder: CreatedFolder) => void;
    canCurate?: boolean;
    /** The transcript is not the viewer's to change; see `TranscriptionPanel`. */
    transcriptReadOnly?: boolean;
    /** Whether the recording is in the Organization: erasing it withdraws it. */
    recordingShared?: boolean;
    onSelectRecording: (r: Recording) => void;
    onRenamed?: (filename: string) => void;
    onDelete: (recording: Recording) => Promise<void>;
    onArtifactsChanged: () => void;
    onBackToList: () => void;
    backLabel?: string;
    /** When true, the pane is hidden (mobile list view active). */
    hiddenOnMobile: boolean;
    initialPlaybackSpeed: number | undefined;
    initialVolume: number | undefined;
    initialAutoPlayNext: boolean | undefined;
    scrubberStyle: "waveform" | "slider" | undefined;
    folders: RecordingFolder[];
    folderAssignments: RecordingFolderAssignment[];
    onSelectFolder: (folder: RecordingFolder) => void;
    onAddToFolder: (recordingId: string, folderId: string) => Promise<void>;
    onRemoveFromFolder: (
        recordingId: string,
        folderId: string,
        withdraw?: boolean,
    ) => Promise<void>;
    onMoveBetweenFolders?: (
        recordingId: string,
        fromFolderId: string,
        toFolderId: string,
    ) => Promise<void>;
    /**
     * Bumped when someone else changes the Organization view of the current
     * recording, so its panels reload what they show.
     */
    contentRevision?: number;
}

/**
 * Right-hand detail pane: player + transcription. On lg+ this is a column
 * next to the recording list and shares the page scrollbar; on <lg the list
 * and detail toggle via `mobileView` -- both stay mounted so list scroll
 * position / search query / selection survive a back-navigation.
 *
 * Auto-advance on player ended (when `autoPlayNext` is on) moves to
 * the next recording in `visibleRecordings`; the back-affordance is
 * mobile-only because desktop has both panes visible at once.
 */
export function WorkstationDetailPane({
    currentRecording,
    itemLinkQuery,
    currentTranscription,
    transcripts,
    isCurrentTranscribing,
    visibleRecordings,
    onTranscribe,
    onTranscribeComplete,
    onTranscriptStale,
    onFolderCreated,
    canCurate,
    transcriptReadOnly,
    recordingShared = false,
    onSelectRecording,
    onRenamed,
    onDelete,
    onArtifactsChanged,
    onBackToList,
    backLabel,
    hiddenOnMobile,
    initialPlaybackSpeed,
    initialVolume,
    initialAutoPlayNext,
    scrubberStyle,
    folders,
    folderAssignments,
    onSelectFolder,
    onAddToFolder,
    onRemoveFromFolder,
    onMoveBetweenFolders,
    contentRevision = 0,
}: Props) {
    const i18n = useExtracted();
    const playerRef = useRef<RecordingPlayerHandle>(null);
    const audioAvailable = hasAudio(currentRecording);
    const playback = useMemo(
        () => (audioAvailable ? transcriptPlayback(playerRef) : null),
        [audioAvailable],
    );
    const playedLink = useRef<string | null>(null);
    const [processingState, setProcessingState] = useState<{
        itemId: string;
        data: ItemProcessingPresentation | null;
    } | null>(null);
    const currentRecordingId = currentRecording?.id;
    const processing =
        processingState && processingState.itemId === currentRecordingId
            ? processingState.data
            : null;
    const handleProcessingChange = useCallback(
        (data: ItemProcessingPresentation | null) => {
            if (!currentRecordingId) return;
            setProcessingState({ itemId: currentRecordingId, data });
        },
        [currentRecordingId],
    );
    useEffect(() => {
        if (!currentRecording || !playback) return;
        const params = new URLSearchParams(
            itemLinkQuery ?? window.location.search,
        );
        if (params.get("recording") !== currentRecording.id) return;
        if (
            (params.get("view") === "org") !==
            (currentRecording.view === "org")
        )
            return;
        const raw = params.get("playFrom");
        if (raw === null) {
            playedLink.current = null;
            return;
        }
        if (!/^\d+$/.test(raw)) return;
        const startMs = Number(raw);
        if (!Number.isSafeInteger(startMs)) return;
        const link = `${currentRecording.id}:${currentRecording.view}:${raw}`;
        if (playedLink.current === link) return;
        if (!playerRef.current) return;
        playedLink.current = link;
        playback.play(startMs);
    }, [currentRecording, itemLinkQuery, playback]);
    const hasTranscript =
        currentRecording?.hasTranscript ??
        Boolean(
            currentTranscription?.text ||
                transcripts?.some((transcript) => transcript.text),
        );

    return (
        <PlaybackProvider playback={playback}>
            <div
                className={cn(
                    "min-w-0 space-y-6 lg:block lg:self-start",
                    hiddenOnMobile && "hidden",
                )}
            >
                {/*
              Mobile back affordance. Returns to the list view without
              dropping the selected recording -- reopening shows the
              same detail. Hidden on lg+ where both panes are visible
              at once.
            */}
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onBackToList}
                    className="-ml-2 h-9 gap-1 px-2 lg:hidden"
                >
                    <ArrowLeft className="size-4" />{" "}
                    {backLabel ?? i18n("Recent")}
                </Button>
                {currentRecording ? (
                    <>
                        <RecordingPlayerHeader
                            recording={currentRecording}
                            onRenamed={onRenamed}
                            shared={recordingShared}
                            // The title follows the transcript's rule: the
                            // organization account renames it on the
                            // Organization view, the owner on their own.
                            titleReadOnly={transcriptReadOnly}
                            action={
                                // Erasing and deleting are the owner's, on their
                                // own view; a shared recording leaves the
                                // Organization first.
                                currentRecording.view === "org" ? undefined : (
                                    <EraseRecordingMenu
                                        recording={currentRecording}
                                        shared={recordingShared}
                                        onDeleteLocal={onDelete}
                                        onChanged={onArtifactsChanged}
                                    />
                                )
                            }
                        />
                        <ItemWorkflow
                            itemId={currentRecording.id}
                            kind="audio"
                            folders={folders}
                            folderAssignments={folderAssignments}
                            onSelectFolder={onSelectFolder}
                            onAddToFolder={onAddToFolder}
                            onRemoveFromFolder={onRemoveFromFolder}
                            isOwn={currentRecording.isOwn !== false}
                            canWithdraw={
                                currentRecording.isOwn !== false ||
                                (currentRecording.view === "org" &&
                                    transcriptReadOnly === false)
                            }
                            view={
                                currentRecording.view === "org"
                                    ? "org"
                                    : "private"
                            }
                            onMoveBetweenFolders={onMoveBetweenFolders}
                            onChanged={onArtifactsChanged}
                            onFolderCreated={onFolderCreated}
                            canCurate={canCurate}
                            onTranscribe={(retranscribe) =>
                                onTranscribe(undefined, retranscribe)
                            }
                            onLearn={() =>
                                openWidget(
                                    `recording-learn-review-${currentRecording.id}`,
                                )
                            }
                            onSummary={() =>
                                openWidget(
                                    `recording-summary-${currentRecording.id}`,
                                )
                            }
                            onReviewLearn={() =>
                                openWidget(
                                    `recording-learn-review-${currentRecording.id}`,
                                )
                            }
                            onReviewTasks={() =>
                                openWidget(
                                    `recording-task-review-${currentRecording.id}`,
                                )
                            }
                            onProcessingChange={handleProcessingChange}
                        />
                        {audioAvailable && (
                            <RecordingPlayer
                                ref={playerRef}
                                recording={currentRecording}
                                initialPlaybackSpeed={initialPlaybackSpeed}
                                initialVolume={initialVolume}
                                initialAutoPlayNext={initialAutoPlayNext}
                                scrubberStyle={scrubberStyle}
                                onEnded={() => {
                                    const currentIndex =
                                        visibleRecordings.findIndex(
                                            (r) => r.id === currentRecording.id,
                                        );
                                    if (
                                        currentIndex >= 0 &&
                                        currentIndex <
                                            visibleRecordings.length - 1
                                    ) {
                                        onSelectRecording(
                                            visibleRecordings[currentIndex + 1],
                                        );
                                    }
                                }}
                            />
                        )}
                        {(!currentRecording.audioReaped || hasTranscript) && (
                            <TranscriptionPanel
                                key={`${currentRecording.id}:${currentRecording.view ?? "private"}:${contentRevision}:${currentRecording.audioReaped ? 1 : 0}:${hasTranscript ? 1 : 0}:${currentRecording.hasSummary ? 1 : 0}`}
                                recording={currentRecording}
                                transcription={currentTranscription}
                                transcripts={transcripts}
                                isTranscribing={isCurrentTranscribing}
                                onTranscribe={onTranscribe}
                                onTranscribeComplete={onTranscribeComplete}
                                onTranscriptStale={onTranscriptStale}
                                readOnly={transcriptReadOnly}
                                shared={recordingShared}
                                processing={processing}
                            />
                        )}
                    </>
                ) : (
                    <Card>
                        <CardContent className="py-16 text-center">
                            <p className="text-muted-foreground">
                                {i18n("Select an item to view its details")}
                            </p>
                        </CardContent>
                    </Card>
                )}
            </div>
        </PlaybackProvider>
    );
}
