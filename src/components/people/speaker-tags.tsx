"use client";

import { Loader2, X } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import { toastApiError } from "@/lib/api-errors";
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
}

export interface SpeakerResponseRow {
    label: string;
    personId: string | null;
    personName: string | null;
    status: string;
    markedUnknown?: boolean;
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

/** What naming a speaker sends: a person, a new name, or "unknown". */
type SpeakerChoice =
    | { personId: string }
    | { displayName: string }
    | { unknown: true };

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
    const [version, setVersion] = useState<{
        transcriptionId: string;
        revision: number;
    } | null>(null);

    const applyResponse = useCallback(
        (body: SpeakersResponse) => {
            onAttributionsChange(confirmedAttributions(body.speakers));
            setUnknownLabels(unknownSpeakerLabels(body.speakers));
            if (
                typeof body.transcriptionId === "string" &&
                typeof body.revision === "number"
            ) {
                setVersion({
                    transcriptionId: body.transcriptionId,
                    revision: body.revision,
                });
            }
        },
        [onAttributionsChange],
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
        // Not loaded yet: there is no version to name.
        if (!version) return false;
        setSavingLabel(label);
        const response = await fetch(speakersUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label, ...(choice ?? {}), ...version }),
        }).catch(() => null);
        setSavingLabel(null);

        if (!response) {
            toast.error(i18n("Could not reach the server"));
            return false;
        }
        if (response.status === 409) {
            // Re-transcribed meanwhile: the label may mean someone else now.
            toast.error(
                i18n(
                    "This transcript changed meanwhile. Its speakers were reloaded; try again.",
                ),
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
            });
            return false;
        }

        applyResponse((await response.json()) as SpeakersResponse);
        return true;
    }

    if (speakers.length === 0) return null;

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
                            href={`/people/${attribution.personId}`}
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
