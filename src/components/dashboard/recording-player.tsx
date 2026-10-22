"use client";

import type * as React from "react";
import { type RefObject, useImperativeHandle } from "react";
import { RecordingPlayerControls } from "@/components/dashboard/recording-player-controls";
import { RecordingWaveformStatus } from "@/components/dashboard/recording-player-header";
import { DownloadAudioButton } from "@/components/recordings/download-audio-button";
import { Card, CardContent } from "@/components/ui/card";
import { usePlaybackEngine } from "@/hooks/use-playback-engine";
import { usePlaybackKeyboard } from "@/hooks/use-playback-keyboard";
import type {
    PlaybackState,
    TranscriptPlayback,
} from "@/hooks/use-transcript-follow";
import { useWaveform } from "@/hooks/use-waveform";
import type { Recording } from "@/types/recording";

interface RecordingPlayerProps {
    recording: Recording;
    onEnded?: () => void;
    initialPlaybackSpeed?: number;
    initialVolume?: number;
    initialAutoPlayNext?: boolean;
    /**
     * Which scrubber style to render. `"slider"` forces the plain
     * progress bar even when waveform peaks are available; `"waveform"`
     * shows the canvas waveform when peaks exist and falls back to the
     * slider otherwise. Read from userSettings.playerScrubber.
     */
    scrubberStyle?: "waveform" | "slider";
}

export interface RecordingPlayerHandle {
    seekTo: (seconds: number) => void;
    /** Play from a moment; with `untilSeconds`, pause once it is reached. */
    playFrom: (seconds: number, untilSeconds?: number) => void;
    pause: () => void;
    /** Called with the position now and whenever it moves or playback starts or stops. */
    subscribe: (listener: (state: PlaybackState) => void) => () => void;
}

interface PlaybackOwner {
    id: string | null;
    pending: boolean;
}

const ownerByPlayer = new WeakMap<
    RefObject<RecordingPlayerHandle | null>,
    PlaybackOwner
>();

function playbackOwner(
    ref: RefObject<RecordingPlayerHandle | null>,
): PlaybackOwner {
    let owner = ownerByPlayer.get(ref);
    if (!owner) {
        owner = { id: null, pending: false };
        ownerByPlayer.set(ref, owner);
    }
    return owner;
}

/** A transcript's view of the player behind `ref`, read when it is used. */
export function transcriptPlayback(
    ref: RefObject<RecordingPlayerHandle | null>,
): TranscriptPlayback {
    const owner = playbackOwner(ref);
    return {
        play: (ms, nextOwner, untilMs) => {
            owner.id = nextOwner ?? null;
            owner.pending = owner.id !== null;
            ref.current?.playFrom(
                ms / 1000,
                untilMs === undefined ? undefined : untilMs / 1000,
            );
            owner.pending = false;
        },
        pause: () => {
            owner.id = null;
            owner.pending = false;
            ref.current?.pause();
        },
        seek: (ms) => {
            owner.id = null;
            owner.pending = false;
            ref.current?.seekTo(ms / 1000);
        },
        subscribe: (listener) =>
            ref.current?.subscribe((state) => {
                if (!state.playing && !owner.pending) owner.id = null;
                listener({ ...state, owner: owner.id });
                if (state.playing) owner.pending = false;
            }) ?? (() => {}),
    };
}

/**
 * Audio playback card for a single recording. State is owned by
 * usePlaybackEngine (audio element + transport state); keyboard
 * shortcuts by usePlaybackKeyboard; waveform peaks by useWaveform.
 * This component is the composition root + the hidden <audio>
 * element that the engine writes to.
 */
export function RecordingPlayer({
    recording,
    onEnded,
    initialPlaybackSpeed = 1.0,
    initialVolume = 75,
    initialAutoPlayNext = false,
    scrubberStyle = "waveform",
    ref,
}: RecordingPlayerProps & { ref?: React.Ref<RecordingPlayerHandle> }) {
    const {
        audioRef,
        subscribe,
        isPlaying,
        currentTime,
        duration,
        volume,
        setVolume,
        playbackSpeed,
        togglePlayPause,
        playFrom,
        pause,
        seekToRatio,
        seekToTime,
        seekRelative,
        cycleSpeed,
        toggleMute,
    } = usePlaybackEngine({
        recording,
        onEnded,
        initialPlaybackSpeed,
        initialVolume,
        initialAutoPlayNext,
    });

    useImperativeHandle(
        ref,
        () => ({
            seekTo: seekToTime,
            playFrom,
            pause,
            subscribe,
        }),
        [seekToTime, playFrom, pause, subscribe],
    );

    usePlaybackKeyboard({
        onToggle: togglePlayPause,
        onSeekRelative: seekRelative,
        onVolumeDelta: (delta) =>
            setVolume((prev) => Math.max(0, Math.min(100, prev + delta))),
    });

    // Waveform peaks: cached server-side if present, decoded
    // client-side on first listen for recordings under
    // AUTO_DECODE_MAX_MS. Long recordings show a manual "Generate
    // waveform" button instead so we don't surprise the user with a
    // multi-hundred-MB decode.
    const {
        peaks: waveformPeaks,
        status: waveformStatus,
        decode: triggerWaveformDecode,
    } = useWaveform({
        recordingId: recording.id,
        durationMs: recording.duration,
        initialPeaks: recording.waveformPeaks ?? null,
        // Skip auto-decode entirely when the user has opted out of the
        // waveform UI -- there's no point spending CPU on peaks the
        // player will never display -- or when retention has removed the
        // audio, where the decode could only ever fetch a 410.
        autoStart: scrubberStyle === "waveform",
    });

    return (
        <Card className="gap-3 py-5 sm:py-6">
            <CardContent className="space-y-2">
                <RecordingPlayerControls
                    isPlaying={isPlaying}
                    onTogglePlay={togglePlayPause}
                    currentTime={currentTime}
                    duration={duration}
                    onSeekRatio={seekToRatio}
                    playbackSpeed={playbackSpeed}
                    onCycleSpeed={cycleSpeed}
                    volume={volume}
                    onVolumeChange={setVolume}
                    onToggleMute={toggleMute}
                    scrubberStyle={scrubberStyle}
                    waveformPeaks={waveformPeaks}
                    trailingAction={
                        <DownloadAudioButton recordingId={recording.id} />
                    }
                />

                <RecordingWaveformStatus
                    scrubberStyle={scrubberStyle}
                    waveformStatus={waveformStatus}
                    onDecodeWaveform={triggerWaveformDecode}
                />

                <audio ref={audioRef} preload="metadata" className="hidden">
                    <track kind="captions" />
                </audio>
            </CardContent>
        </Card>
    );
}
