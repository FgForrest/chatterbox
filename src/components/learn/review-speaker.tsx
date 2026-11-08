"use client";

import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import { SpeakerClips } from "@/components/learn/speaker-clips";
import { useSpeakerSource } from "@/components/learn/speaker-source";
import { useSpeakerAccent } from "@/components/people/speaker-accent-context";
import type { SpeakerAccent } from "@/components/people/speaker-accents";
import { useSpeakerLabel } from "@/components/people/use-speaker-label";
import {
    PlayAtIcon,
    type PlayAtTarget,
    usePlayAt,
} from "@/components/playback/play-at-button";
import { Button } from "@/components/ui/button";
import type { SpeakerProposalContext } from "@/lib/learn/output";
import { formatClock } from "@/lib/topics/timeline";
import type {
    SpeakerSamples,
    SpeakingStats,
} from "@/lib/transcript/speech-samples";

/** Whom a speaker of the review is: someone, explicitly nobody, or not yet. */
export type ReviewSpeakerPerson = { name: string } | { unknown: true } | null;

/**
 * One speaker of a Learn review, as a chip like the transcript's speaker
 * tags: its colour, the label, and whom it is. Ticked, it reads as a named
 * speaker; unticked, as a suggestion. Play hears the speaker's next turn.
 */
export function ReviewSpeaker({
    label,
    person,
    accent: fallbackAccent,
    ticked,
    blocked,
    disabled,
    recorder,
    onlyFirstName,
    reason,
    source,
    guess,
    evidence,
    samples,
    stats,
    unmentioned,
    waits,
    onTick,
    onPick,
    onUnknown,
    nextTurn,
}: SpeakerProposalContext & {
    label: string;
    person: ReviewSpeakerPerson;
    accent: SpeakerAccent;
    ticked: boolean;
    /** Nobody to accept yet, or someone the review adds is not ticked. */
    blocked: boolean;
    disabled: boolean;
    /** Learn reads this speaker as whoever made the recording. */
    recorder: boolean;
    /** Only a first name was heard, and it is someone known. */
    onlyFirstName: boolean;
    reason: string;
    evidence: readonly { ms: number; untilMs: number; quote: string }[];
    samples: SpeakerSamples;
    stats: SpeakingStats;
    unmentioned?: boolean;
    waits: ReactNode;
    onTick: (ticked: boolean) => void;
    onPick: () => void;
    onUnknown: () => void;
    nextTurn?: () => PlayAtTarget | null;
}) {
    const speakerSource = useSpeakerSource();
    const play = usePlayAt();
    const i18n = useExtracted();
    const accent = useSpeakerAccent(label, fallbackAccent);
    const speakerLabel = useSpeakerLabel();
    const speaker = speakerLabel(label);
    const unknown = person !== null && "unknown" in person;
    const name = person && "name" in person ? person.name : null;
    const named = ticked && !blocked && !unknown && name !== null;
    // A suggestion until it is ticked; then a named speaker, or nobody.
    let chip = "border-dashed border-primary/40 text-muted-foreground";
    let shown = i18n("{name}?", { name: name ?? "" });
    if (unknown) {
        chip = "border-dashed bg-muted/30 text-muted-foreground";
        shown = i18n("unknown");
    } else if (named) {
        chip = "border-primary/30 bg-primary/10";
        shown = name;
    }
    const divider = named ? "border-primary/20" : "border-dashed";
    return (
        <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg bg-muted/50 p-3 text-sm">
            <input
                type="checkbox"
                className="mt-2 size-4 shrink-0"
                checked={ticked && !blocked}
                disabled={blocked || disabled || person === null}
                aria-label={i18n("Accept {label} as {name}", {
                    label: speaker,
                    name: unknown ? i18n("unknown") : (name ?? "?"),
                })}
                onChange={(event) => onTick(event.target.checked)}
            />
            <div className="contents @min-[560px]/learn:block @min-[560px]/learn:min-w-0 @min-[560px]/learn:space-y-2">
                <div className="contents @min-[560px]/learn:flex @min-[560px]/learn:flex-wrap @min-[560px]/learn:items-center @min-[560px]/learn:gap-2">
                    <span
                        className={`inline-flex h-8 max-w-full items-center overflow-hidden rounded-full border text-xs font-medium ${chip}`}
                    >
                        {nextTurn && play.available && (
                            <button
                                type="button"
                                onClick={() => {
                                    if (play.playing) play.toggle();
                                    else {
                                        const target = nextTurn();
                                        if (target) play.toggle(target);
                                    }
                                }}
                                aria-pressed={play.playing}
                                aria-label={
                                    play.playing
                                        ? i18n("Pause")
                                        : i18n("Play a turn of {speaker}", {
                                              speaker,
                                          })
                                }
                                title={i18n("Listen")}
                                className={`flex h-full items-center border-r px-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary ${play.playing ? "text-primary" : ""} ${divider}`}
                            >
                                <PlayAtIcon playing={play.playing} />
                            </button>
                        )}
                        <span className="inline-flex h-full min-w-0 items-center gap-2 px-2">
                            <span
                                className={`size-1.5 shrink-0 rounded-full ${accent.dot} ${unknown ? "opacity-50" : ""}`}
                            />
                            <span className="text-muted-foreground">
                                {speaker}
                            </span>
                            <span aria-hidden="true">→</span>
                            <span
                                className={`truncate ${named ? "text-foreground" : ""}`}
                            >
                                {shown}
                            </span>
                        </span>
                    </span>
                    {recorder && (
                        <span
                            className="rounded-full bg-primary/10 px-1.5 text-xs text-primary"
                            title={i18n(
                                "You made this recording, and this speaker leads it.",
                            )}
                        >
                            {i18n("you")}
                        </span>
                    )}
                    <div className="col-span-2 mt-2 flex w-full gap-2 @min-[560px]/learn:mt-0 @min-[560px]/learn:w-auto">
                        <Button
                            size="sm"
                            variant="outline"
                            className="min-h-11 flex-1 px-2 text-xs @min-[560px]/learn:flex-none"
                            disabled={disabled}
                            onClick={onPick}
                        >
                            {name === null
                                ? i18n("Choose a person…")
                                : i18n("Someone else…")}
                        </Button>
                        <Button
                            size="sm"
                            variant={unknown ? "default" : "outline"}
                            className="min-h-11 flex-1 px-2 text-xs @min-[560px]/learn:flex-none"
                            aria-pressed={unknown}
                            disabled={disabled}
                            onClick={onUnknown}
                        >
                            {i18n("Unknown")}
                        </Button>
                    </div>
                    <span className="col-span-2 mt-2 w-full text-xs text-muted-foreground @min-[560px]/learn:ml-auto @min-[560px]/learn:mt-0 @min-[560px]/learn:w-auto">
                        {i18n(
                            "speaks {time} · {count, plural, one {# reply} other {# replies}}",
                            {
                                time: formatClock(stats.durationMs).replace(
                                    /^0/u,
                                    "",
                                ),
                                count: stats.replies,
                            },
                        )}
                    </span>
                </div>
                <div className="col-span-2 mt-2 min-w-0 space-y-2 @min-[560px]/learn:mt-0">
                    {onlyFirstName && (
                        <div className="text-xs text-amber-700 dark:text-amber-400">
                            {i18n(
                                "Only the first name was heard: someone else of that name may be speaking.",
                            )}
                        </div>
                    )}
                    {waits}
                    <div className="text-xs text-muted-foreground">
                        {unmentioned ? (
                            i18n(
                                "Learn did not recognise this speaker. Listen and choose who it is.",
                            )
                        ) : (
                            <>
                                <span>{speakerSource({ source, guess })}</span>{" "}
                                {reason}
                            </>
                        )}
                    </div>
                    <SpeakerClips samples={samples} evidence={evidence} />
                </div>
            </div>
        </div>
    );
}
