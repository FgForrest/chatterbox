"use client";

import { Check, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useItemPartVersion } from "@/components/items/item-detail-store";
import { useSpeakerSource } from "@/components/learn/speaker-source";
import { speakerAccent } from "@/components/people/speaker-accents";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import type { PlayAtTarget } from "@/components/playback/play-at-button";
import { SpeakerTurnChip } from "@/components/playback/play-turn-button";
import { usePlayback } from "@/components/playback/playback-context";
import { useProductName } from "@/components/product-name-provider";
import { useItemPartFetch } from "@/hooks/use-item-part-fetch";
import { parseApiError, toastApiError } from "@/lib/api-errors";
import { speakerGroups } from "@/lib/knowledge/speaker-groups";
import {
    resolveSpeakerAttribution,
    type SpeakerAttributions,
    speakerAnchorId,
} from "@/lib/knowledge/speaker-references";
import type { SpeakerProposalContext } from "@/lib/learn/output";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

export interface TranscriptSpeakerTag {
    speaker: string;
    label: string;
}

interface SpeakerTagsProps {
    recordingId: string;
    source: string;
    transcriptIdentity?: string;
    transcriptPending?: boolean;
    refreshKey?: number;
    speakers: TranscriptSpeakerTag[];
    attributions: SpeakerAttributions;
    onAttributionsChange: (attributions: SpeakerAttributions) => void;
    onUnknownLabelsChange?: (labels: ReadonlySet<string>) => void;
    /**
     * On the Organization view names come from, and go to, the Organization's
     * knowledge base, for everyone who can see the recording.
     */
    view?: RecordingView;
    /**
     * Select a speaker's next timed turn, or null when none exists. Without
     * audio, the chip's button only selects it.
     */
    nextSpeakerTurn?: (
        speaker: string | readonly string[],
    ) => PlayAtTarget | null;
    /**
     * The version of the transcript on screen, from the page's data. Every
     * change names it; without it, the version the speakers were read at.
     */
    shownVersion?: TranscriptVersionRef;
    /** The transcript on screen was replaced: reload the page's transcripts. */
    onStale?: (reason: "transcript" | "sharing") => void;
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
    source?: string;
    confidence?: number | null;
    proposal?: SpeakerProposalContext & { reason: string };
    markedUnknown?: boolean;
    evidenceStartMs?: number | null;
}

/** A name a machine proposed for a label, waiting for a person's answer. */
export interface SpeakerSuggestion {
    proposal?: SpeakerProposalContext & { reason?: string };
    /** A name carried from an older transcript, awaiting confirmation. */
    carried?: boolean;
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
            carried: speaker.source === "heuristic",
            personId: speaker.personId,
            name: speaker.personName,
            evidenceStartMs: speaker.evidenceStartMs ?? null,
            proposal: speaker.proposal ?? {
                source:
                    speaker.source === "calendar" || speaker.source === "meet"
                        ? speaker.source
                        : "transcript",
                ...(speaker.confidence != null && speaker.confidence < 0.5
                    ? {
                          guess: {
                              confidence: speaker.confidence,
                              clues: [],
                          },
                      }
                    : {}),
            },
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
/** Speakers and the stored transcript revision they describe. */
export interface SpeakersResponse {
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
        if (!speaker.personName) continue;
        confirmed[speaker.label] = {
            personId: speaker.personId ?? "",
            name: speaker.personName,
        };
    }
    return confirmed;
}

/** Editable participant tags for the currently selected transcript. */
export function SpeakerTags({
    recordingId,
    source,
    transcriptIdentity,
    transcriptPending,
    refreshKey,
    speakers,
    attributions,
    onAttributionsChange,
    onUnknownLabelsChange,
    view,
    nextSpeakerTurn,
    shownVersion,
    onStale,
    readOnly = false,
}: SpeakerTagsProps) {
    const i18n = useExtracted();
    const productName = useProductName();
    const speakerSource = useSpeakerSource();
    const playback = usePlayback();
    const speakersUrl = withRecordingView(
        `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
        view,
    );
    const [picker, setPicker] = useState<{
        identity: string;
        label: string;
        voices: string[];
        version: TranscriptVersionRef | null;
    } | null>(null);
    const [unlinkingLabels, setUnlinkingLabels] = useState<readonly string[]>(
        [],
    );
    const [savingLabel, setSavingLabel] = useState<string | null>(null);
    const shownId = shownVersion?.transcriptionId;
    const shownRevision = shownVersion?.revision;
    const identity =
        transcriptIdentity ??
        `${recordingId}:${source}:${shownId}:${shownRevision}`;
    const scope = useMemo(
        () => ({ identity, speakersUrl }),
        [identity, speakersUrl],
    );
    const currentScope = useRef<typeof scope | null>(scope);
    useEffect(() => {
        currentScope.current = scope;
        return () => {
            currentScope.current = null;
        };
    }, [scope]);
    const onStaleRef = useRef(onStale);
    onStaleRef.current = onStale;
    const version = useItemPartVersion("speakers", source);
    const [loaded, setLoaded] = useState<{
        identity: string;
        body: SpeakersResponse;
    }>();
    const { reload: load, setData: setSpeakerData } =
        useItemPartFetch<SpeakersResponse>(speakersUrl, version, identity, {
            paused: transcriptPending,
            fallbackRevision: refreshKey,
            onLoad: applyResponse,
        });

    function applyResponse(body: SpeakersResponse) {
        if (
            shownVersion &&
            typeof body.transcriptionId === "string" &&
            typeof body.revision === "number" &&
            (body.transcriptionId !== shownId ||
                body.revision !== shownRevision)
        ) {
            onStaleRef.current?.("transcript");
            return;
        }
        setLoaded({ identity, body });
        onAttributionsChange(confirmedAttributions(body.speakers));
        onUnknownLabelsChange?.(unknownSpeakerLabels(body.speakers));
    }

    const body = loaded?.identity === identity ? loaded.body : undefined;
    const unknownLabels = unknownSpeakerLabels(body?.speakers);
    const suggestions = suggestedSpeakers(body?.speakers);
    const readVersion =
        typeof body?.transcriptionId === "string" &&
        typeof body?.revision === "number"
            ? { transcriptionId: body.transcriptionId, revision: body.revision }
            : null;
    const seenVersion = shownVersion ?? readVersion;
    const openPicker =
        picker?.identity === identity &&
        picker.version?.transcriptionId === seenVersion?.transcriptionId &&
        picker.version?.revision === seenVersion?.revision
            ? picker
            : null;
    if (picker && !openPicker) setPicker(null);

    async function attribute(
        label: string,
        choice: SpeakerChoice | null,
        seen = seenVersion,
    ): Promise<boolean> {
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
            onStaleRef.current?.(
                error.code === "RECORDING_SHARED" ? "sharing" : "transcript",
            );
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

        const body = (await response.json()) as SpeakersResponse;
        if (currentScope.current === scope && setSpeakerData(body)) {
            applyResponse(body);
            invalidateItemProcessing(recordingId);
        }
        return true;
    }

    async function unlinkGroup(labels: readonly string[]) {
        setUnlinkingLabels(labels);
        try {
            for (const label of labels) {
                if (currentScope.current !== scope) break;
                if (!(await attribute(label, null))) {
                    await load();
                    break;
                }
            }
        } finally {
            setUnlinkingLabels([]);
        }
    }

    const groups = speakerGroups(
        speakers.map(({ speaker }) => speaker),
        attributions,
    );
    if (speakers.length === 0) return null;

    const openSpeaker = speakers.find(
        (speaker) => speaker.speaker === openPicker?.label,
    );
    const segmentClass =
        "inline-flex h-full min-h-7 min-w-7 items-center justify-center px-2 transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60";

    return (
        <>
            <fieldset
                className="flex min-w-0 flex-wrap items-center gap-2"
                aria-label={i18n("Transcript speakers")}
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
                    const saving = labels.some(
                        (label) =>
                            label === savingLabel ||
                            unlinkingLabels.includes(label),
                    );
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
                        playback && suggestion && evidenceMs != null,
                    );
                    const label =
                        attribution?.name ??
                        (suggestion
                            ? suggestion.carried
                                ? suggestion.name
                                : i18n("{name}?", { name: suggestion.name })
                            : unknown
                              ? i18n("{speaker}: unknown", {
                                    speaker: speaker.label,
                                })
                              : speaker.label);

                    const renderLabel = () => {
                        if (
                            readOnly &&
                            attribution?.personId &&
                            view !== "received"
                        ) {
                            return (
                                <Link
                                    href={`/almanac/${attribution.personId}`}
                                    className={`${segmentClass} min-w-0 break-words pr-3 text-left`}
                                >
                                    {label}
                                </Link>
                            );
                        }
                        if (readOnly) {
                            return (
                                <span className="min-w-0 pl-2 pr-3 break-words">
                                    {label}
                                </span>
                            );
                        }
                        return (
                            <button
                                type="button"
                                className={`${segmentClass} min-w-0 break-words text-left ${suggestion || attribution || unknown ? "" : "pr-3"}`}
                                disabled={saving}
                                aria-haspopup="dialog"
                                onClick={() => {
                                    setPicker({
                                        identity,
                                        voices: labels,
                                        label: speaker.speaker,
                                        version: seenVersion,
                                    });
                                }}
                                title={
                                    suggestion
                                        ? [
                                              !suggestion.carried &&
                                                  speakerSource(
                                                      suggestion.proposal ?? {},
                                                  ),
                                              suggestion.carried
                                                  ? i18n(
                                                        "Suggested from the previous transcript.",
                                                    )
                                                  : null,
                                              i18n("Pick someone else"),
                                          ]
                                              .filter(Boolean)
                                              .join(" ")
                                        : undefined
                                }
                            >
                                {label}
                            </button>
                        );
                    };

                    return (
                        <SpeakerTurnChip
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            speaker={speaker.speaker}
                            chipClassName={`inline-flex h-8 max-w-full items-center overflow-hidden rounded-full border text-xs font-medium ${attribution ? "border-primary/30 bg-primary/10" : "border-dashed bg-muted/30 text-muted-foreground"}`}
                            className={`${segmentClass} shrink-0 ${accent}`}
                            label={
                                canPlayEvidence
                                    ? i18n("Play where {speaker} speaks", {
                                          speaker: speaker.label,
                                      })
                                    : i18n("Play the next turn of {name}", {
                                          name,
                                      })
                            }
                            showLabel={i18n(
                                "Show the next turn of {name} in the transcript",
                                { name },
                            )}
                            contextTurn={
                                nextSpeakerTurn
                                    ? () =>
                                          nextSpeakerTurn(
                                              labels.length === 1
                                                  ? labels[0]
                                                  : labels,
                                          )
                                    : null
                            }
                            nextTurn={
                                canPlayEvidence && evidenceMs != null
                                    ? () => ({ ms: evidenceMs })
                                    : nextSpeakerTurn
                                      ? () =>
                                            nextSpeakerTurn(
                                                labels.length === 1
                                                    ? labels[0]
                                                    : labels,
                                            )
                                      : undefined
                            }
                        >
                            {labels.slice(1).map((label) => (
                                <span key={label} id={speakerAnchorId(label)} />
                            ))}
                            {renderLabel()}
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
                        </SpeakerTurnChip>
                    );
                })}
            </fieldset>
            {readOnly && view !== "received" && (
                <p className="text-xs text-muted-foreground">
                    {i18n("Managed by the Organization")}
                </p>
            )}
            {!readOnly && openPicker && openSpeaker && (
                <SpeakerPicker
                    label={openSpeaker.label}
                    personId={
                        resolveSpeakerAttribution(
                            attributions,
                            openSpeaker.speaker,
                        )?.personId
                    }
                    voices={
                        openPicker.voices.length > 1
                            ? openPicker.voices.flatMap((label) => {
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
                    onVoiceChange={(label) =>
                        setPicker((current) =>
                            current ? { ...current, label } : null,
                        )
                    }
                    nextVoiceTurn={
                        nextSpeakerTurn
                            ? (label) => nextSpeakerTurn(label)
                            : undefined
                    }
                    onUnlinkVoice={(label) =>
                        attribute(label, null, openPicker.version)
                    }
                    organizationOnly={view === "org"}
                    onPick={(choice) =>
                        attribute(
                            openSpeaker.speaker,
                            choice,
                            openPicker.version,
                        )
                    }
                    onMarkUnknown={() =>
                        attribute(
                            openSpeaker.speaker,
                            { unknown: true },
                            openPicker.version,
                        )
                    }
                    onClose={() => setPicker(null)}
                />
            )}
        </>
    );
}
