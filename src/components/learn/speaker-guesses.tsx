"use client";

import { Check, GraduationCap, Loader2, Play, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import type {
    LearnMarks,
    LearnSpeakerMark,
} from "@/components/learn/learn-marks";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api-errors";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";

/**
 * The speakers a waiting Learn review proposes to name, above the
 * transcript: each accepted at once (named now, and ticked in the review),
 * or all of them together; "not them" unticks it in the review. What the
 * review adds for a new person links to whoever the name made, so finishing
 * the review adds nobody twice.
 */
export function SpeakerGuesses({
    recordingId,
    source,
    view,
    shownVersion,
    marks,
    confirmedLabels,
    onAccepted,
    onSeek,
}: {
    recordingId: string;
    source: string;
    view?: RecordingView;
    /** The transcript on screen; a speaker change names it. */
    shownVersion?: { transcriptionId: string; revision: number };
    marks: LearnMarks;
    /** Labels already named: their guesses are no longer shown. */
    confirmedLabels: ReadonlySet<string>;
    /** Speakers were named here: the speaker strip reads them again. */
    onAccepted: () => void;
    onSeek?: (ms: number) => void;
}) {
    const i18n = useExtracted();
    const [busy, setBusy] = useState<string | null>(null);
    // Accepted here, until the strip has read them back.
    const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());

    // Declined ones stay, faded, to be accepted after all.
    const shown = Object.values(marks.speakers)
        .filter(
            (guess) =>
                !confirmedLabels.has(guess.label) && !accepted.has(guess.label),
        )
        .sort((a, b) =>
            a.label.localeCompare(b.label, undefined, { numeric: true }),
        );
    const guesses = shown.filter((guess) => !guess.declined);
    if (shown.length === 0) return null;

    /** Name the speaker now, then tick the guess in the review. */
    const accept = async (guess: LearnSpeakerMark): Promise<boolean> => {
        const { answer } = guess;
        const response = await fetch(
            withRecordingView(
                `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
                view,
            ),
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    label: guess.label,
                    ...("personId" in answer
                        ? { personId: answer.personId }
                        : { displayName: answer.displayName }),
                    ...(shownVersion ?? {}),
                }),
            },
        ).catch(() => null);
        if (!response?.ok) {
            toast.error(
                response
                    ? await getApiErrorMessage(
                          response,
                          i18n("Failed to identify this speaker"),
                      )
                    : i18n("Could not reach the server"),
            );
            return false;
        }
        setAccepted((current) => new Set([...current, guess.label]));
        // Someone new: the review's new record is whoever the name made.
        if ("recordItemId" in answer && answer.recordItemId) {
            const body = (await response.json().catch(() => null)) as {
                speakers?: { label: string; personId: string | null }[];
            } | null;
            const personId = body?.speakers?.find(
                (row) => row.label === guess.label,
            )?.personId;
            if (personId) {
                await marks.decide(answer.recordItemId, "accepted", {
                    personId,
                });
            }
        }
        await marks.decide(guess.itemId, "accepted");
        return true;
    };

    const acceptOne = async (guess: LearnSpeakerMark) => {
        setBusy(guess.label);
        try {
            if (await accept(guess)) onAccepted();
        } finally {
            setBusy(null);
        }
    };

    const acceptAll = async () => {
        setBusy("*");
        let named = 0;
        try {
            for (const guess of guesses) {
                if (await accept(guess)) named++;
            }
        } finally {
            setBusy(null);
            if (named > 0) onAccepted();
        }
    };

    return (
        <section
            aria-label={i18n("Speaker guesses")}
            className="space-y-2 rounded-lg border border-dashed border-primary/40 p-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium">
                    <GraduationCap className="size-4" />
                    {i18n("Speaker guesses")}
                </span>
                {guesses.length > 1 && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={busy !== null}
                        onClick={() => void acceptAll()}
                    >
                        {busy === "*" ? (
                            <Loader2 className="size-3 animate-spin" />
                        ) : (
                            <Check className="size-3" />
                        )}
                        {i18n("Accept all")}
                    </Button>
                )}
            </div>
            <div className="flex flex-wrap gap-2">
                {shown.map((guess) => {
                    const speaker = formatSpeakerLabel(guess.label);
                    const evidenceMs = guess.evidenceMs[0];
                    const declined = guess.declined;
                    const saving = busy === guess.label || busy === "*";
                    return (
                        <span
                            key={guess.label}
                            className={`inline-flex h-8 items-center overflow-hidden rounded-full border border-dashed border-primary/40 text-xs font-medium ${declined ? "opacity-50" : ""}`}
                        >
                            {onSeek && evidenceMs !== undefined && (
                                <button
                                    type="button"
                                    onClick={() => onSeek(evidenceMs)}
                                    aria-label={i18n(
                                        "Play where {speaker} speaks",
                                        { speaker },
                                    )}
                                    title={i18n("Listen")}
                                    className="flex h-full items-center border-r border-dashed border-primary/30 px-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
                                >
                                    <Play className="size-3" />
                                </button>
                            )}
                            <span
                                className="inline-flex h-full items-center gap-1 px-3"
                                title={
                                    guess.recorder
                                        ? i18n(
                                              "You made this recording, and this speaker leads it.",
                                          )
                                        : guess.onlyFirstName
                                          ? i18n(
                                                "Only the first name was heard: someone else of that name may be speaking.",
                                            )
                                          : undefined
                                }
                            >
                                <span className="text-muted-foreground">
                                    {speaker}
                                </span>
                                →
                                <span>
                                    {guess.onlyFirstName
                                        ? i18n("{name}?", { name: guess.name })
                                        : guess.name}
                                </span>
                                {guess.recorder && (
                                    <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                                        {i18n("you")}
                                    </span>
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => void acceptOne(guess)}
                                disabled={busy !== null}
                                aria-label={i18n(
                                    "Confirm {name} as {speaker}",
                                    { name: guess.name, speaker },
                                )}
                                title={i18n("Confirm")}
                                className="flex h-full items-center border-l border-dashed border-primary/30 px-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-60"
                            >
                                {saving ? (
                                    <Loader2 className="size-3 animate-spin" />
                                ) : (
                                    <Check className="size-3" />
                                )}
                            </button>
                            {!declined && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        void marks.decide(
                                            guess.itemId,
                                            "rejected",
                                        )
                                    }
                                    disabled={busy !== null}
                                    aria-label={i18n(
                                        "{speaker} is not {name}",
                                        { name: guess.name, speaker },
                                    )}
                                    title={i18n("Not this person")}
                                    className="flex h-full items-center border-l border-dashed border-primary/30 px-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                                >
                                    <X className="size-3" />
                                </button>
                            )}
                        </span>
                    );
                })}
            </div>
        </section>
    );
}
