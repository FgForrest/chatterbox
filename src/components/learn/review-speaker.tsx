"use client";

import { Play } from "lucide-react";
import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import type { SpeakerAccent } from "@/components/people/speaker-accents";
import { Button } from "@/components/ui/button";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";

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
    accent,
    ticked,
    blocked,
    disabled,
    recorder,
    onlyFirstName,
    reason,
    evidence,
    waits,
    onTick,
    onPick,
    onUnknown,
    onPlay,
}: {
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
    evidence: ReactNode;
    waits: ReactNode;
    onTick: (ticked: boolean) => void;
    onPick: () => void;
    onUnknown: () => void;
    onPlay?: () => void;
}) {
    const i18n = useExtracted();
    const speaker = formatSpeakerLabel(label);
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
        <div className="-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50">
            <input
                type="checkbox"
                className="mt-2 size-4 shrink-0"
                checked={ticked && !blocked}
                disabled={blocked || disabled}
                aria-label={i18n("Accept {label} as {name}", {
                    label,
                    name: unknown ? i18n("unknown") : (name ?? "?"),
                })}
                onChange={(event) => onTick(event.target.checked)}
            />
            <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span
                        className={`inline-flex h-8 items-center overflow-hidden rounded-full border text-xs font-medium ${chip}`}
                    >
                        {onPlay && (
                            <button
                                type="button"
                                onClick={onPlay}
                                aria-label={i18n("Play a turn of {speaker}", {
                                    speaker,
                                })}
                                title={i18n("Listen")}
                                className={`flex h-full items-center border-r px-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground ${divider}`}
                            >
                                <Play className="size-3" />
                            </button>
                        )}
                        <span className="inline-flex h-full items-center gap-2 px-3">
                            <span
                                className={`size-1.5 shrink-0 rounded-full ${accent.dot} ${unknown ? "opacity-50" : ""}`}
                            />
                            <span className="text-muted-foreground">
                                {speaker}
                            </span>
                            <span aria-hidden="true">→</span>
                            <span className={named ? "text-foreground" : ""}>
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
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        disabled={disabled}
                        onClick={onPick}
                    >
                        {i18n("Someone else…")}
                    </Button>
                    <Button
                        size="sm"
                        variant={unknown ? "default" : "outline"}
                        className="h-6 px-2 text-xs"
                        aria-pressed={unknown}
                        disabled={disabled}
                        onClick={onUnknown}
                    >
                        {i18n("Unknown")}
                    </Button>
                </div>
                {onlyFirstName && (
                    <div className="text-xs text-amber-700 dark:text-amber-400">
                        {i18n(
                            "Only the first name was heard: someone else of that name may be speaking.",
                        )}
                    </div>
                )}
                {waits}
                <div className="text-xs text-muted-foreground">
                    {reason} {evidence}
                </div>
            </div>
        </div>
    );
}
