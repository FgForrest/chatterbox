"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { PlaybackState } from "@/hooks/use-transcript-follow";
import type { Recording } from "@/types/recording";

export const PLAYBACK_SPEED_OPTIONS = [
    { label: "0.5x", value: 0.5 },
    { label: "0.75x", value: 0.75 },
    { label: "1x", value: 1.0 },
    { label: "1.25x", value: 1.25 },
    { label: "1.5x", value: 1.5 },
    { label: "2x", value: 2.0 },
] as const;

interface Options {
    recording: Recording;
    onEnded?: () => void;
    initialPlaybackSpeed?: number;
    initialVolume?: number;
    initialAutoPlayNext?: boolean;
}

function elementState(audio: HTMLAudioElement | null): PlaybackState {
    return {
        ms: (audio?.currentTime ?? 0) * 1000,
        playing: Boolean(audio && !audio.paused && !audio.ended),
    };
}

/** Own the audio transport and derive its UI state from the media element. */
export function usePlaybackEngine({
    recording,
    onEnded,
    initialPlaybackSpeed = 1.0,
    initialVolume = 75,
    initialAutoPlayNext = false,
}: Options) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(initialVolume);
    const [playbackSpeed, setPlaybackSpeed] = useState(initialPlaybackSpeed);
    const [autoPlayNext] = useState(initialAutoPlayNext);
    const audioRef = useRef<HTMLAudioElement>(null);
    const listeners = useRef(new Set<(state: PlaybackState) => void>());
    const stopAt = useRef<number | null>(null);
    const pendingSeek = useRef<number | null>(null);
    const playRequest = useRef(0);
    const onEndedRef = useRef(onEnded);
    onEndedRef.current = onEnded;

    const syncPlaying = useCallback(() => {
        const state = elementState(audioRef.current);
        setIsPlaying(state.playing);
        for (const listener of listeners.current) listener(state);
    }, []);

    const subscribe = useCallback(
        (listener: (state: PlaybackState) => void) => {
            listeners.current.add(listener);
            listener(elementState(audioRef.current));
            return () => {
                listeners.current.delete(listener);
            };
        },
        [],
    );

    const pause = useCallback(() => {
        playRequest.current++;
        stopAt.current = null;
        audioRef.current?.pause();
        syncPlaying();
    }, [syncPlaying]);

    const play = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const request = ++playRequest.current;
        audio.playbackRate = playbackSpeed;
        audio.play().catch((error: unknown) => {
            if (request !== playRequest.current) return;
            stopAt.current = null;
            syncPlaying();
            if (error instanceof Error && error.name === "AbortError") return;
            console.error("Error playing audio:", error);
            toast.error("Failed to play audio");
        });
        syncPlaying();
    }, [playbackSpeed, syncPlaying]);

    const setPosition = useCallback((seconds: number) => {
        const audio = audioRef.current;
        if (!audio || !Number.isFinite(seconds)) return;
        const requested = Math.max(0, seconds);
        const next =
            Number.isFinite(audio.duration) && audio.duration > 0
                ? Math.min(audio.duration, requested)
                : requested;
        if (audio.readyState === 0) {
            pendingSeek.current = next;
        } else {
            pendingSeek.current = null;
            audio.currentTime = next;
        }
        setCurrentTime(next);
    }, []);

    const seekToTime = useCallback(
        (seconds: number) => {
            if (!Number.isFinite(seconds)) return;
            stopAt.current = null;
            setPosition(seconds);
        },
        [setPosition],
    );

    const playFrom = useCallback(
        (seconds: number, untilSeconds?: number) => {
            if (!Number.isFinite(seconds)) return;
            stopAt.current =
                untilSeconds !== undefined &&
                Number.isFinite(untilSeconds) &&
                untilSeconds > Math.max(0, seconds)
                    ? untilSeconds
                    : null;
            setPosition(seconds);
            play();
        },
        [setPosition, play],
    );

    const togglePlayPause = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        stopAt.current = null;
        if (audio.paused || audio.ended) play();
        else pause();
    }, [play, pause]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const updateTime = () => {
            setCurrentTime(audio.currentTime);
            if (
                stopAt.current !== null &&
                pendingSeek.current === null &&
                !audio.seeking &&
                !audio.paused &&
                audio.currentTime >= stopAt.current
            ) {
                pause();
            }
            syncPlaying();
        };
        const updateDuration = () => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
                setDuration(audio.duration);
            }
        };
        const loadedMetadata = () => {
            updateDuration();
            if (pendingSeek.current !== null) setPosition(pendingSeek.current);
            syncPlaying();
        };
        const stopped = () => {
            if (audio.paused || audio.ended) stopAt.current = null;
            syncPlaying();
        };
        const emptied = () => {
            if (audio.paused && audio.readyState === 0) {
                playRequest.current++;
                setCurrentTime(0);
                setDuration(0);
            }
            stopped();
        };
        const ended = () => {
            stopped();
            if (audio.ended && autoPlayNext) onEndedRef.current?.();
        };
        const handlers: [keyof HTMLMediaElementEventMap, () => void][] = [
            ["play", syncPlaying],
            ["playing", syncPlaying],
            ["pause", stopped],
            ["emptied", emptied],
            ["error", stopped],
            ["ended", ended],
            ["timeupdate", updateTime],
            ["seeking", updateTime],
            ["seeked", updateTime],
            ["loadedmetadata", loadedMetadata],
            ["durationchange", updateDuration],
        ];
        for (const [type, handler] of handlers) {
            audio.addEventListener(type, handler);
        }
        stopAt.current = null;
        pendingSeek.current = null;
        setCurrentTime(0);
        setDuration(0);
        audio.src = `/api/recordings/${recording.id}/audio`;
        audio.load();
        syncPlaying();
        return () => {
            playRequest.current++;
            stopAt.current = null;
            pendingSeek.current = null;
            for (const [type, handler] of handlers) {
                audio.removeEventListener(type, handler);
            }
            if (!audio.paused) audio.pause();
        };
    }, [recording.id, autoPlayNext, pause, setPosition, syncPlaying]);

    useEffect(() => {
        if (audioRef.current) audioRef.current.volume = volume / 100;
    }, [volume]);

    useEffect(() => {
        if (audioRef.current) audioRef.current.playbackRate = playbackSpeed;
    }, [playbackSpeed]);

    const seekToRatio = useCallback(
        (ratio: number) => {
            const audio = audioRef.current;
            if (
                !audio ||
                !Number.isFinite(ratio) ||
                !Number.isFinite(audio.duration) ||
                audio.duration <= 0
            )
                return;
            seekToTime(Math.max(0, Math.min(1, ratio)) * audio.duration);
        },
        [seekToTime],
    );

    const seekRelative = useCallback(
        (deltaSeconds: number) => {
            const audio = audioRef.current;
            if (!audio) return;
            seekToTime(
                (pendingSeek.current ?? audio.currentTime) + deltaSeconds,
            );
        },
        [seekToTime],
    );

    const cycleSpeed = useCallback(() => {
        setPlaybackSpeed((speed) => {
            const index = PLAYBACK_SPEED_OPTIONS.findIndex(
                (option) => option.value === speed,
            );
            return PLAYBACK_SPEED_OPTIONS[
                (index + 1) % PLAYBACK_SPEED_OPTIONS.length
            ].value;
        });
    }, []);

    const previousVolumeRef = useRef<number>(volume > 0 ? volume : 75);
    useEffect(() => {
        if (volume > 0) previousVolumeRef.current = volume;
    }, [volume]);
    const toggleMute = useCallback(() => {
        setVolume((value) => (value > 0 ? 0 : previousVolumeRef.current || 75));
    }, []);

    return {
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
    };
}
