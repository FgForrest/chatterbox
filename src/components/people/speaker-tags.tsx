"use client";

import { Check, Loader2, Play, X } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import { parseApiError, toastApiError } from "@/lib/api-errors";
import {
    type SpeakerAttributions,
    speakerAnchorId,
} from "@/lib/knowledge/speaker-references";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

const SPEAKER_ACCENTS = [
    "bg-primary",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-violet-500",
    "bg-rose-500",
    "bg-sky-500",
] as const;

export interface TranscriptSpeakerTag {
    speaker: string;
    label: string;
}

interface SpeakerTagsProps {
    recordingId: string;
    source: string;
    speakers: TranscriptSpeakerTag[];
    attributions: SpeakerAttributions;
    onAttributionsChange: (attributions: SpeakerAttributions) => void;
    /**
     * On the Organization view names come from, and go to, the Organization's
     * knowledge base, for everyone who can see the recording.
     */
    view?: RecordingView;
    /** Play the recording from a moment, to hear a suggestion's evidence. */
    onSeek?: (ms: number) => void;
    /**
     * The version of the transcript on screen, from the page's data. Every
     * change names it; without it, the version the speakers were read at.
     */
    shownVersion?: TranscriptVersionRef;
    /** The transcript on screen was replaced: reload the page's transcripts. */
    onStale?: () => void;
    /**
     * Show the names without changing them: the Organization manages the
     * speakers of a shared recording.
     */
    readOnly?: boolean;
}

/** One stored transcript, at one revision. */
interface TranscriptVersionRef {
    transcriptionId: string;
    revision: number;
}

export interface SpeakerResponseRow {
    label: string;
    personId: string | null;
    personName: string | null;
    status: string;
    markedUnknown?: boolean;
    evidenceStartMs?: number | null;
}

/** A name a machine proposed for a label, waiting for a person's answer. */
export interface SpeakerSuggestion {
    personId: string;
    name: string;
    evidenceStartMs: number | null;
}

/** Suggestions by label. The route sends them only to who may act on them. */
export function suggestedSpeakers(
    speakers: SpeakerResponseRow[] | undefined,
): Readonly<Record<string, SpeakerSuggestion>> {
    const suggestions: Record<string, SpeakerSuggestion> = {};
    for (const speaker of speakers ?? []) {
        if (speaker.status !== "suggested") continue;
        if (!speaker.personId || !speaker.personName) continue;
        suggestions[speaker.label] = {
            personId: speaker.personId,
            name: speaker.personName,
            evidenceStartMs: speaker.evidenceStartMs ?? null,
        };
    }
    return suggestions;
}

/** Labels a person answered "nobody known" for. */
export function unknownSpeakerLabels(
    speakers: SpeakerResponseRow[] | undefined,
): ReadonlySet<string> {
    return new Set(
        (speakers ?? [])
            .filter(
                (speaker) =>
                    speaker.status === "confirmed" && speaker.markedUnknown,
            )
            .map((speaker) => speaker.label),
    );
}

/** What the speakers route answers, reads and writes alike. */
interface SpeakersResponse {
    /** The transcript shown, and its version; every change names both. */
    transcriptionId?: string;
    revision?: number;
    speakers?: SpeakerResponseRow[];
}

/**
 * What an answer sends: a person, a new name, "unknown", or "not this
 * suggested person".
 */
type SpeakerChoice =
    | { personId: string }
    | { displayName: string }
    | { unknown: true }
    | { personId: string; reject: true };

export function confirmedAttributions(
    speakers: SpeakerResponseRow[] | undefined,
): SpeakerAttributions {
    const confirmed: Record<string, { personId: string; name: string }> = {};
    for (const speaker of speakers ?? []) {
        if (speaker.status !== "confirmed") continue;
        if (!speaker.personId || !speaker.personName) continue;
        confirmed[speaker.label] = {
            personId: speaker.personId,
            name: speaker.personName,
        };
    }
    return confirmed;
}

/** Editable participant tags for the currently selected transcript. */
export function SpeakerTags({
    recordingId,
    source,
    speakers,
    attributions,
    onAttributionsChange,
    view,
    onSeek,
    shownVersion,
    onStale,
    readOnly = false,
}: SpeakerTagsProps) {
    const i18n = useExtracted();
    const speakersUrl = withRecordingView(
        `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
        view,
    );
    const [openLabel, setOpenLabel] = useState<string | null>(null);
    const [savingLabel, setSavingLabel] = useState<string | null>(null);
    const [unknownLabels, setUnknownLabels] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [suggestions, setSuggestions] = useState<
        Readonly<Record<string, SpeakerSuggestion>>
    >({});
    const [version, setVersion] = useState<TranscriptVersionRef | null>(null);
    const shownId = shownVersion?.transcriptionId;
    const shownRevision = shownVersion?.revision;
    // Latest callback without re-reading the speakers when its identity
    // changes on a re-render.
    const onStaleRef = useRef(onStale);
    onStaleRef.current = onStale;

    // The panel mounts a new instance for another transcript; an answer
    // arriving after that belongs to the one it replaced.
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const applyResponse = useCallback(
        (body: SpeakersResponse) => {
            if (!mounted.current) return;
            const read =
                typeof body.transcriptionId === "string" &&
                typeof body.revision === "number"
                    ? {
                          transcriptionId: body.transcriptionId,
                          revision: body.revision,
                      }
                    : null;
            // Speakers of a newer transcript than the text on screen would
            // put names on the wrong lines: fetch the text instead.
            if (
                read &&
                shownId !== undefined &&
                (read.transcriptionId !== shownId ||
                    read.revision !== shownRevision)
            ) {
                onStaleRef.current?.();
                return;
            }
            onAttributionsChange(confirmedAttributions(body.speakers));
            setUnknownLabels(unknownSpeakerLabels(body.speakers));
            setSuggestions(suggestedSpeakers(body.speakers));
            if (read) setVersion(read);
        },
        [onAttributionsChange, shownId, shownRevision],
    );

    const load = useCallback(
        async (isCancelled: () => boolean = () => false) => {
            const body = await fetch(speakersUrl)
                .then(async (response) =>
                    response.ok
                        ? ((await response.json()) as SpeakersResponse)
                        : null,
                )
                .catch(() => null);
            if (body && !isCancelled()) applyResponse(body);
        },
        [applyResponse, speakersUrl],
    );

    useEffect(() => {
        let cancelled = false;
        setOpenLabel(null);
        setVersion(null);
        void load(() => cancelled);
        return () => {
            cancelled = true;
        };
    }, [load]);

    /** Save an answer for one label; `null` takes the answer back. */
    async function attribute(
        label: string,
        choice: SpeakerChoice | null,
    ): Promise<boolean> {
        // The text on screen, else what the speakers were read at; neither
        // before the first read, or when it failed.
        const seen =
            shownId !== undefined && shownRevision !== undefined
                ? { transcriptionId: shownId, revision: shownRevision }
                : version;
        if (!seen) {
            toast.error(
                i18n("The speakers are still loading. Try again in a moment."),
            );
            await load();
            return false;
        }
        setSavingLabel(label);
        const response = await fetch(speakersUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label, ...(choice ?? {}), ...seen }),
        }).catch(() => null);
        setSavingLabel(null);

        if (!response) {
            toast.error(i18n("Could not reach the server"));
            return false;
        }
        if (response.status === 409) {
            const error = await parseApiError(response);
            toast.error(
                error.code === "RECORDING_SHARED"
                    ? // Shared meanwhile: the page reloads it as read-only.
                      i18n(
                          "This recording was shared meanwhile. The Organization manages its speakers now.",
                      )
                    : // Re-transcribed meanwhile: the label may mean someone
                      // else now.
                      i18n(
                          "This transcript changed meanwhile. Its speakers were reloaded; try again.",
                      ),
            );
            onStaleRef.current?.();
            await load();
            return false;
        }
        if (!response.ok) {
            await toastApiError(response, {
                fallback: choice
                    ? i18n("Failed to identify this speaker")
                    : i18n("Failed to unlink this speaker"),
                errorContext: "update a transcript speaker",
            });
            return false;
        }

        applyResponse((await response.json()) as SpeakersResponse);
        return true;
    }

    if (speakers.length === 0) return null;

    if (readOnly) {
        return (
            <fieldset
                className="flex flex-wrap items-center gap-2 pt-3"
                aria-label={i18n("Transcript speakers")}
            >
                {speakers.map((speaker, index) => {
                    const attribution = attributions[speaker.speaker];
                    const accent =
                        SPEAKER_ACCENTS[index % SPEAKER_ACCENTS.length];
                    const dot = (
                        <span className={`size-1.5 rounded-full ${accent}`} />
                    );
                    if (attribution) {
                        return (
                            <Link
                                key={speaker.speaker}
                                id={speakerAnchorId(speaker.speaker)}
                                href={`/almanac/${attribution.personId}`}
                                className="inline-flex h-8 items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 text-xs font-medium transition-colors hover:bg-primary/20"
                            >
                                {dot}
                                {attribution.name}
                            </Link>
                        );
                    }
                    return (
                        <span
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            className="inline-flex h-8 items-center gap-2 rounded-full border bg-muted/30 px-3 text-xs font-medium text-muted-foreground"
                        >
                            {dot}
                            {unknownLabels.has(speaker.speaker)
                                ? i18n("{speaker}: unknown", {
                                      speaker: speaker.label,
                                  })
                                : speaker.label}
                        </span>
                    );
                })}
                <span className="text-xs text-muted-foreground">
                    {i18n("Managed by the Organization")}
                </span>
            </fieldset>
        );
    }

    const openSpeaker = speakers.find(
        (speaker) => speaker.speaker === openLabel,
    );

    return (
        <fieldset
            className="flex flex-wrap items-center gap-2 pt-3"
            aria-label={i18n("Transcript speakers")}
        >
            {speakers.map((speaker, index) => {
                const attribution = attributions[speaker.speaker];
                const saving = savingLabel === speaker.speaker;
                const accent = SPEAKER_ACCENTS[index % SPEAKER_ACCENTS.length];

                if (!attribution && unknownLabels.has(speaker.speaker)) {
                    return (
                        <span
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            className="inline-flex h-8 items-center overflow-hidden rounded-full border border-dashed bg-muted/30 text-xs font-medium text-muted-foreground"
                        >
                            <span className="inline-flex h-full items-center gap-2 pl-3 pr-2">
                                <span
                                    className={`size-1.5 rounded-full opacity-50 ${accent}`}
                                />
                                {i18n("{speaker}: unknown", {
                                    speaker: speaker.label,
                                })}
                            </span>
                            <button
                                type="button"
                                onClick={() =>
                                    void attribute(speaker.speaker, null)
                                }
                                disabled={saving}
                                aria-label={i18n(
                                    "Clear the answer for {speaker}",
                                    { speaker: speaker.label },
                                )}
                                title={i18n("Clear")}
                                className="flex h-full items-center border-l px-2 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                            >
                                {saving ? (
                                    <Loader2 className="size-3 animate-spin" />
                                ) : (
                                    <X className="size-3" />
                                )}
                            </button>
                        </span>
                    );
                }

                const suggestion = attribution
                    ? undefined
                    : suggestions[speaker.speaker];
                if (suggestion) {
                    const evidenceMs = suggestion.evidenceStartMs;
                    return (
                        <span
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            className="inline-flex h-8 items-center overflow-hidden rounded-full border border-dashed border-primary/40 text-xs font-medium"
                        >
                            {onSeek && evidenceMs !== null && (
                                <button
                                    type="button"
                                    onClick={() => onSeek(evidenceMs)}
                                    aria-label={i18n(
                                        "Play where {speaker} speaks",
                                        { speaker: speaker.label },
                                    )}
                                    title={i18n("Listen")}
                                    className="flex h-full items-center border-r border-dashed border-primary/30 px-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
                                >
                                    <Play className="size-3" />
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setOpenLabel(speaker.speaker)}
                                disabled={saving}
                                title={i18n(
                                    "Suggested for {speaker}. Pick someone else",
                                    { speaker: speaker.label },
                                )}
                                className="inline-flex h-full items-center gap-2 pl-3 pr-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-60"
                            >
                                <span
                                    className={`size-1.5 rounded-full ${accent}`}
                                />
                                {i18n("{name}?", { name: suggestion.name })}
                            </button>
                            <button
                                type="button"
                                onClick={() =>
                                    void attribute(speaker.speaker, {
                                        personId: suggestion.personId,
                                    })
                                }
                                disabled={saving}
                                aria-label={i18n(
                                    "Confirm {name} as {speaker}",
                                    {
                                        name: suggestion.name,
                                        speaker: speaker.label,
                                    },
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
                            <button
                                type="button"
                                onClick={() =>
                                    void attribute(speaker.speaker, {
                                        personId: suggestion.personId,
                                        reject: true,
                                    })
                                }
                                disabled={saving}
                                aria-label={i18n("{speaker} is not {name}", {
                                    name: suggestion.name,
                                    speaker: speaker.label,
                                })}
                                title={i18n("Not this person")}
                                className="flex h-full items-center border-l border-dashed border-primary/30 px-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    );
                }

                if (!attribution) {
                    return (
                        <button
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            type="button"
                            onClick={() => setOpenLabel(speaker.speaker)}
                            disabled={saving}
                            className="inline-flex h-8 items-center gap-2 rounded-full border bg-muted/30 px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground disabled:opacity-60"
                        >
                            <span
                                className={`size-1.5 rounded-full ${accent}`}
                            />
                            {speaker.label}
                            {saving && (
                                <Loader2 className="size-3 animate-spin" />
                            )}
                        </button>
                    );
                }

                return (
                    <span
                        key={speaker.speaker}
                        id={speakerAnchorId(speaker.speaker)}
                        className="inline-flex h-8 items-center overflow-hidden rounded-full border border-primary/30 bg-primary/10 text-xs font-medium"
                    >
                        <Link
                            href={`/almanac/${attribution.personId}`}
                            className="inline-flex h-full items-center gap-2 pl-3 pr-2 transition-colors hover:bg-primary/10"
                        >
                            <span
                                className={`size-1.5 rounded-full ${accent}`}
                            />
                            {attribution.name}
                        </Link>
                        <button
                            type="button"
                            onClick={() =>
                                void attribute(speaker.speaker, null)
                            }
                            disabled={saving}
                            aria-label={i18n("Unlink {name} from {speaker}", {
                                name: attribution.name,
                                speaker: speaker.label,
                            })}
                            title={i18n("Unlink {name}", {
                                name: attribution.name,
                            })}
                            className="flex h-full items-center border-l border-primary/20 px-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                        >
                            {saving ? (
                                <Loader2 className="size-3 animate-spin" />
                            ) : (
                                <X className="size-3" />
                            )}
                        </button>
                    </span>
                );
            })}

            {openSpeaker && (
                <SpeakerPicker
                    label={openSpeaker.label}
                    organizationOnly={view === "org"}
                    onPick={(choice) => attribute(openSpeaker.speaker, choice)}
                    onMarkUnknown={() =>
                        attribute(openSpeaker.speaker, { unknown: true })
                    }
                    onClose={() => setOpenLabel(null)}
                />
            )}
        </fieldset>
    );
}
