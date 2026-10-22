"use client";

import { Pause, Play } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { usePlayback } from "@/components/playback/playback-context";
import { formatClock } from "@/lib/topics/timeline";
import { cn } from "@/lib/utils";

/** A moment to play, optionally stopping at the end of a turn. */
export interface PlayAtTarget {
    ms: number;
    untilMs?: number;
    /** End of the control's active range; audio keeps playing past it. */
    endMs?: number;
}

function insideActiveRange(target: PlayAtTarget | null, ms: number) {
    if (target?.endMs === undefined) return true;
    return ms >= target.ms && ms < target.endMs;
}

/** Owns a play shortcut and toggles it against the shared player state. */
export function usePlayAt(target?: PlayAtTarget) {
    const playback = usePlayback();
    const owner = useId();
    const started = useRef<PlayAtTarget | null>(null);
    const [observed, setObserved] = useState<{
        playback: typeof playback;
        playing: boolean;
    } | null>(null);
    useEffect(() => {
        return playback?.subscribe((state) => {
            const playing =
                state.playing &&
                state.owner === owner &&
                insideActiveRange(started.current, state.ms);
            setObserved((current) =>
                current?.playback === playback && current.playing === playing
                    ? current
                    : { playback, playing },
            );
        });
    }, [playback, owner]);
    const playing =
        observed?.playback === playback && observed?.playing === true;
    const toggle = (next = target) => {
        if (playing) playback?.pause();
        else if (next) {
            started.current = next;
            playback?.play(next.ms, owner, next.untilMs);
        }
    };
    return { available: playback !== null, playing, toggle };
}

/** The shared filled transport icon used by every play shortcut. */
export function PlayAtIcon({
    playing,
    className,
}: {
    playing: boolean;
    className?: string;
}) {
    const Icon = playing ? Pause : Play;
    return (
        <Icon
            aria-hidden="true"
            className={cn("size-3 fill-current", className)}
        />
    );
}

/** Plays a moment with an owner, showing pause only for its own playback. */
export function PlayAtButton({
    ms,
    untilMs,
    label,
    playLabel,
    title,
    withoutAudio = "nothing",
}: {
    ms: number;
    untilMs?: number;
    label?: string;
    playLabel?: string;
    title?: string;
    withoutAudio?: "nothing" | "label";
}) {
    const i18n = useExtracted();
    const { available, playing, toggle } = usePlayAt({ ms, untilMs });
    const time = formatClock(ms);
    const shown = label ?? time;
    const isTime = label === undefined || label === time;
    if (!available) {
        return withoutAudio === "label" ? (
            <span
                className={cn(
                    "text-xs text-muted-foreground",
                    isTime && "tabular-nums",
                )}
            >
                {shown}
            </span>
        ) : null;
    }
    let ariaLabel = playing ? i18n("Pause") : (playLabel ?? shown);
    if (isTime) {
        ariaLabel = playing
            ? i18n("Pause at {time}", { time })
            : i18n("Play from {time}", { time });
    }
    return (
        <button
            type="button"
            className={cn(
                "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary",
                isTime && "tabular-nums",
                playing && "text-primary",
            )}
            title={title}
            aria-label={ariaLabel}
            aria-pressed={playing}
            onClick={() => toggle()}
        >
            <PlayAtIcon playing={playing} />
            {shown}
        </button>
    );
}

/** Keeps one timestamp for each displayed second, preserving occurrence order. */
export function distinctPlayTimes(times: readonly number[]): number[] {
    const seen = new Set<string>();
    return times.filter((ms) => {
        const time = formatClock(ms);
        if (seen.has(time)) return false;
        seen.add(time);
        return true;
    });
}
