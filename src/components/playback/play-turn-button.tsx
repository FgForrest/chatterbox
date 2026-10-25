"use client";

import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import {
    PlayAtIcon,
    type PlayAtTarget,
    usePlayAt,
} from "@/components/playback/play-at-button";
import { cn } from "@/lib/utils";

interface TurnButtonProps {
    nextTurn?: () => PlayAtTarget | null;
    contextTurn?: (() => PlayAtTarget | null) | null;
    label: string;
    /**
     * Without audio, the label of a button that only selects the next turn
     * in the transcript; without it, the button is hidden.
     */
    showLabel?: string;
    className?: string;
    disabled?: boolean;
}

function useTurnPlayback({
    nextTurn,
    contextTurn = nextTurn,
    showLabel,
}: TurnButtonProps) {
    const play = usePlayAt();
    const toggleTurn = (
        resolve: (() => PlayAtTarget | null) | null | undefined,
    ) => {
        if (!resolve) return false;
        if (!play.available) {
            return showLabel !== undefined && resolve() !== null;
        }
        if (play.playing) {
            play.toggle();
            return true;
        }
        const target = resolve();
        if (!target) return false;
        play.toggle(target);
        return true;
    };
    return { ...play, toggleTurn, contextTurn };
}

function TurnButton({
    play,
    nextTurn,
    label,
    showLabel,
    className,
    disabled,
}: TurnButtonProps & { play: ReturnType<typeof useTurnPlayback> }) {
    const i18n = useExtracted();
    const shown = play.available ? label : showLabel;
    if (!nextTurn || shown === undefined) return null;
    return (
        <button
            type="button"
            data-speaker-play=""
            disabled={disabled}
            className={cn(
                "text-xs text-muted-foreground hover:text-primary",
                className,
                play.playing && "text-primary",
            )}
            aria-label={play.playing ? i18n("Pause") : shown}
            title={play.available ? i18n("Listen") : i18n("Show in transcript")}
            aria-pressed={play.available ? play.playing : undefined}
            onClick={() => play.toggleTurn(nextTurn)}
            onContextMenu={(event) => {
                event.stopPropagation();
                if (play.toggleTurn(play.contextTurn)) {
                    event.preventDefault();
                }
            }}
        >
            <PlayAtIcon playing={play.playing} />
        </button>
    );
}

/** Plays a selected speaker turn, advancing the cursor only when starting playback. */
export function PlayTurnButton(props: TurnButtonProps) {
    const play = useTurnPlayback(props);
    return <TurnButton {...props} play={play} />;
}

/**
 * A speaker chip whose play button and context menu share the same turn
 * cursor. Without audio, given a `showLabel`, both only select the turn.
 */
export function SpeakerTurnChip({
    id,
    speaker,
    chipClassName,
    children,
    ...props
}: TurnButtonProps & {
    id: string;
    speaker: string;
    chipClassName: string;
    children: ReactNode;
}) {
    const play = useTurnPlayback(props);
    return (
        <fieldset
            id={id}
            data-speaker={speaker}
            className={chipClassName}
            onContextMenu={(event) => {
                if (play.toggleTurn(play.contextTurn)) event.preventDefault();
            }}
        >
            <TurnButton {...props} play={play} />
            {children}
        </fieldset>
    );
}
