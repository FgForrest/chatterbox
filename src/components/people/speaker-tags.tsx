"use client";

import { Check, Loader2, Play, X } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { speakerAccent } from "@/components/people/speaker-accents";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import { useProductName } from "@/components/product-name-provider";
import { parseApiError, toastApiError } from "@/lib/api-errors";
import { speakerGroups } from "@/lib/knowledge/speaker-groups";
import {
    resolveSpeakerAttribution,
    type SpeakerAttributions,
    speakerAnchorId,
} from "@/lib/knowledge/speaker-references";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

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
    /** Play a speaker's next timed turn; false leaves the browser menu alone. */
    onPlaySpeaker?: (speaker: string | readonly string[]) => boolean;
    /**
     * The version of the transcript on screen, from the page's data. Every
     * change names it; without it, the version the speakers were read at.
     */
    shownVersion?: TranscriptVersionRef;
    /** The transcript on screen was replaced: reload the page's transcripts. */
    onStale?: () => void;
    /** The labels answered "nobody known", each time they are read. */
    onUnknownLabelsChange?: (labels: ReadonlySet<string>) => void;
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
    onPlaySpeaker,
    shownVersion,
    onStale,
    onUnknownLabelsChange,
    readOnly = false,
}: SpeakerTagsProps) {
    const i18n = useExtracted();
    const productName = useProductName();
    const speakersUrl = withRecordingView(
        `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
        view,
    );
    const [openLabel, setOpenLabel] = useState<string | null>(null);
    const [openVoices, setOpenVoices] = useState<string[]>([]);
    const [unlinking, setUnlinking] = useState(false);
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
    const onUnknownLabelsChangeRef = useRef(onUnknownLabelsChange);
    onUnknownLabelsChangeRef.current = onUnknownLabelsChange;

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
            const unknown = unknownSpeakerLabels(body.speakers);
            setUnknownLabels(unknown);
            onUnknownLabelsChangeRef.current?.(unknown);
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
                productName,
            });
            return false;
        }

        applyResponse((await response.json()) as SpeakersResponse);
        return true;
    }

    async function unlinkGroup(labels: readonly string[]) {
        setUnlinking(true);
        try {
            for (const label of labels) {
                if (!mounted.current) break;
                if (!(await attribute(label, null))) {
                    await load();
                    break;
                }
            }
        } finally {
            setUnlinking(false);
        }
    }

    const groups = speakerGroups(
        speakers.map(({ speaker }) => speaker),
        attributions,
    );
    const playGroup = (labels: readonly string[]) =>
        onPlaySpeaker?.(labels.length === 1 ? labels[0] : labels);
    if (speakers.length === 0) return null;

    const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const speaker =
            target.closest<HTMLElement>("[data-speaker]")?.dataset.speaker;
        const group = groups.find(({ labels }) =>
            labels.includes(speaker ?? ""),
        );
        if (group && playGroup(group.labels)) event.preventDefault();
    };

    const openSpeaker = speakers.find(
        (speaker) => speaker.speaker === openLabel,
    );
    const segmentClass =
        "inline-flex h-full min-h-7 min-w-7 items-center justify-center px-2 transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60";

    return (
        <>
            <fieldset
                className="flex min-w-0 flex-wrap items-center gap-2"
                aria-label={i18n("Transcript speakers")}
                onContextMenu={handleContextMenu}
            >
                {groups.map(({ labels, position }) => {
                    const speaker = speakers.find(
                        (voice) => voice.speaker === labels[0],
                    );
                    if (!speaker) return null;
                    const attribution = resolveSpeakerAttribution(
                        attributions,
                        speaker.speaker,
                    );
                    const unknown = unknownLabels.has(speaker.speaker);
                    const suggestion =
                        attribution || unknown || readOnly
                            ? undefined
                            : suggestions[speaker.speaker];
                    const saving =
                        unlinking ||
                        (savingLabel !== null && labels.includes(savingLabel));
                    const accent = speakerAccent(position).text;
                    const name = attribution?.name ?? speaker.label;
                    const voiceNames = labels
                        .map(
                            (label) =>
                                speakers.find(
                                    (voice) => voice.speaker === label,
                                )?.label ?? label,
                        )
                        .join(", ");
                    const evidenceMs = suggestion?.evidenceStartMs;
                    const canPlayEvidence = Boolean(
                        suggestion && onSeek && evidenceMs != null,
                    );
                    const canListen = canPlayEvidence || Boolean(onPlaySpeaker);
                    const label =
                        attribution?.name ??
                        (suggestion
                            ? i18n("{name}?", { name: suggestion.name })
                            : unknown
                              ? i18n("{speaker}: unknown", {
                                    speaker: speaker.label,
                                })
                              : speaker.label);

                    return (
                        <span
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            data-speaker={speaker.speaker}
                            className={`inline-flex h-8 max-w-full items-center overflow-hidden rounded-full border text-xs font-medium ${attribution ? "border-primary/30 bg-primary/10" : "border-dashed bg-muted/30 text-muted-foreground"}`}
                        >
                            {labels.slice(1).map((label) => (
                                <span key={label} id={speakerAnchorId(label)} />
                            ))}
                            <button
                                type="button"
                                className={`${segmentClass} shrink-0 ${accent}`}
                                disabled={!canListen}
                                aria-label={
                                    canPlayEvidence
                                        ? i18n("Play where {speaker} speaks", {
                                              speaker: speaker.label,
                                          })
                                        : i18n("Play the next turn of {name}", {
                                              name,
                                          })
                                }
                                title={
                                    canPlayEvidence ? i18n("Listen") : undefined
                                }
                                onClick={() => {
                                    if (canPlayEvidence && evidenceMs != null) {
                                        onSeek?.(evidenceMs);
                                    } else playGroup(labels);
                                }}
                            >
                                <Play className="size-3 fill-current" />
                            </button>
                            {readOnly ? (
                                attribution ? (
                                    <Link
                                        href={`/almanac/${attribution.personId}`}
                                        className={`${segmentClass} min-w-0 break-words text-left`}
                                    >
                                        {label}
                                    </Link>
                                ) : (
                                    <span className="min-w-0 px-2 break-words">
                                        {label}
                                    </span>
                                )
                            ) : (
                                <button
                                    type="button"
                                    className={`${segmentClass} min-w-0 break-words text-left`}
                                    disabled={saving}
                                    aria-haspopup="dialog"
                                    onClick={() => {
                                        setOpenVoices(labels);
                                        setOpenLabel(speaker.speaker);
                                    }}
                                    title={
                                        suggestion
                                            ? i18n(
                                                  "Suggested for {speaker}. Pick someone else",
                                                  { speaker: speaker.label },
                                              )
                                            : undefined
                                    }
                                >
                                    {label}
                                </button>
                            )}
                            {!readOnly && suggestion && (
                                <>
                                    <button
                                        type="button"
                                        className={`${segmentClass} shrink-0 border-l border-dashed border-primary/30 hover:text-primary`}
                                        disabled={saving}
                                        onClick={() =>
                                            void attribute(speaker.speaker, {
                                                personId: suggestion.personId,
                                            })
                                        }
                                        aria-label={i18n(
                                            "Confirm {name} as {speaker}",
                                            {
                                                name: suggestion.name,
                                                speaker: speaker.label,
                                            },
                                        )}
                                        title={i18n("Confirm")}
                                    >
                                        {saving ? (
                                            <Loader2 className="size-3 animate-spin" />
                                        ) : (
                                            <Check className="size-3" />
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        className={`${segmentClass} shrink-0 border-l border-dashed border-primary/30 hover:bg-destructive/10 hover:text-destructive`}
                                        disabled={saving}
                                        onClick={() =>
                                            void attribute(speaker.speaker, {
                                                personId: suggestion.personId,
                                                reject: true,
                                            })
                                        }
                                        aria-label={i18n(
                                            "{speaker} is not {name}",
                                            {
                                                speaker: speaker.label,
                                                name: suggestion.name,
                                            },
                                        )}
                                        title={i18n("Not this person")}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </>
                            )}
                            {!readOnly && (attribution || unknown) && (
                                <button
                                    type="button"
                                    className={`${segmentClass} shrink-0 border-l border-primary/20 hover:bg-destructive/10 hover:text-destructive`}
                                    disabled={saving}
                                    onClick={() => void unlinkGroup(labels)}
                                    aria-label={
                                        attribution
                                            ? i18n(
                                                  "Unlink {name} from {speaker}",
                                                  {
                                                      name: attribution.name,
                                                      speaker: voiceNames,
                                                  },
                                              )
                                            : i18n(
                                                  "Clear the answer for {speaker}",
                                                  { speaker: speaker.label },
                                              )
                                    }
                                    title={
                                        attribution
                                            ? i18n("Unlink {name}", {
                                                  name: attribution.name,
                                              })
                                            : i18n("Clear")
                                    }
                                >
                                    {saving ? (
                                        <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                        <X className="size-3" />
                                    )}
                                </button>
                            )}
                        </span>
                    );
                })}
            </fieldset>
            {readOnly && (
                <p className="text-xs text-muted-foreground">
                    {i18n("Managed by the Organization")}
                </p>
            )}
            {!readOnly && openSpeaker && (
                <SpeakerPicker
                    label={openSpeaker.label}
                    personId={
                        resolveSpeakerAttribution(
                            attributions,
                            openSpeaker.speaker,
                        )?.personId
                    }
                    voices={
                        openVoices.length > 1
                            ? openVoices.flatMap((label) => {
                                  const voice = speakers.find(
                                      (speaker) => speaker.speaker === label,
                                  );
                                  if (!voice) return [];
                                  const attribution = resolveSpeakerAttribution(
                                      attributions,
                                      label,
                                  );
                                  return [
                                      {
                                          ...voice,
                                          name: attribution?.name,
                                          linked: Boolean(attribution),
                                      },
                                  ];
                              })
                            : undefined
                    }
                    activeVoice={openSpeaker.speaker}
                    onVoiceChange={setOpenLabel}
                    onPlayVoice={
                        onPlaySpeaker
                            ? (label) => onPlaySpeaker(label)
                            : undefined
                    }
                    onUnlinkVoice={(label) => attribute(label, null)}
                    organizationOnly={view === "org"}
                    onPick={(choice) => attribute(openSpeaker.speaker, choice)}
                    onMarkUnknown={() =>
                        attribute(openSpeaker.speaker, { unknown: true })
                    }
                    onClose={() => setOpenLabel(null)}
                />
            )}
        </>
    );
}
