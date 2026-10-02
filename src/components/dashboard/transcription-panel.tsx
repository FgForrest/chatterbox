"use client";

import {
    ChevronDown,
    ChevronUp,
    FileText,
    Languages,
    ListChecks,
    Loader2,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MarkdownActions } from "@/components/dashboard/markdown-actions";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { TranscriptTopicsMenu } from "@/components/dashboard/transcript-topics-menu";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import type { LearnMarks } from "@/components/learn/learn-marks";
import { LearnReview } from "@/components/learn/learn-review";
import { SpeakerGuesses } from "@/components/learn/speaker-guesses";
import { Markdown } from "@/components/markdown";
import {
    confirmedAttributions,
    type SpeakerResponseRow,
    SpeakerTags,
    type TranscriptSpeakerTag,
} from "@/components/people/speaker-tags";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useLearnFollowUps } from "@/hooks/use-learn-follow-ups";
import { useSummaryPresetCopy } from "@/hooks/use-preset-copy";
import { useTranscriptTopics } from "@/hooks/use-transcript-topics";
import {
    type SummarySource,
    useTranscriptionSummary,
} from "@/hooks/use-transcription-summary";
import { getApiErrorMessage } from "@/lib/api-errors";
import { isUntimed } from "@/lib/knowledge/correction-anchors";
import {
    speakerKey,
    speakerLabelsForTranscript,
} from "@/lib/knowledge/speaker-label-rules";
import {
    inferSummarySpeakerNumberOffset,
    type SpeakerAttributions,
} from "@/lib/knowledge/speaker-references";
import type { OverlayCorrection } from "@/lib/learn/render";
import { withRecordingView } from "@/lib/sharing/view";
import { describeMultiPass } from "@/lib/summary/multi-pass";
import { formatElapsed } from "@/lib/summary/progress-stream";
import type { TranscriptTopic } from "@/lib/topics/timeline";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import type { Recording } from "@/types/recording";

export interface Transcription {
    text?: string;
    language?: string;
    source?: string;
    provider?: string;
    model?: string;
    /** Provider-reported turns, when the transcript was stored with them. */
    turns?: TranscriptTurn[] | null;
    /** Topics detected on this transcript, anchored to `turns`. */
    topics?: TranscriptTopic[] | null;
}

/** A transcript variant for a single source (Plaud, the user's own, etc.). */
export interface TranscriptOption {
    source: string;
    text: string;
    /**
     * Which stored transcript this text is, and its revision. A speaker
     * change names it, so it is refused if the text on screen is no longer
     * the stored one.
     */
    version?: { transcriptionId: string; revision: number };
    language?: string;
    provider?: string;
    model?: string;
    /** Provider-reported turns, when the transcript was stored with them. */
    turns?: TranscriptTurn[] | null;
    /** Topics detected on this transcript, anchored to `turns`. */
    topics?: TranscriptTopic[] | null;
}

interface TranscriptionPanelProps {
    recording: Recording;
    /** Back-compat single transcript. Used only when `transcripts` is absent. */
    transcription?: Transcription;
    /** All transcripts for the recording, one per source, primary first. When
     * more than one is present a source switcher is shown. */
    transcripts?: TranscriptOption[];
    isTranscribing: boolean;
    onTranscribe: (attributionSource?: string) => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    /**
     * Reload the page's transcripts: the one on screen was replaced, e.g.
     * re-transcribed in another tab.
     */
    onTranscriptStale?: () => void;
    /** Seek the recording audio to a provider-reported transcript turn. */
    onSeekToTurn?: (startMs: number) => void;
    /** Seek and start playback for speaker navigation. */
    onPlayFromTurn?: (startMs: number) => void;
    /** Playback position in milliseconds, to mark the topic being played. */
    getPlaybackMs?: () => number;
    /**
     * The recording is not the viewer's to change: while it is shared only
     * the organization account changes it, on the Organization view.
     * Speakers are shown read-only, and no transcription, summary or topic
     * detection is offered.
     */
    readOnly?: boolean;
}

function SourceSwitcher({
    ariaLabel,
    sources,
    value,
    onSelect,
}: {
    ariaLabel: string;
    sources: readonly string[];
    value: string;
    onSelect: (source: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <fieldset
            className="inline-flex shrink-0 rounded-lg bg-muted/70 p-1"
            aria-label={ariaLabel}
        >
            {sources.map((source) => (
                <button
                    key={source}
                    type="button"
                    onClick={() => onSelect(source)}
                    aria-pressed={source === value}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                        source === value
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                    }`}
                >
                    {source === "plaud"
                        ? "Plaud"
                        : source === "mixed"
                          ? i18n("Mix")
                          : i18n("Custom")}
                </button>
            ))}
        </fieldset>
    );
}

/**
 * Normalise the two transcript-shaped props into one list.
 *
 * `source` and `model` must survive the single-transcript path: they are what
 * `TranscriptView` reads to decide whether the text was diarized, so
 * defaulting them here instead of carrying them through silently downgrades a
 * dialog to plain text.
 */
export function toTranscriptList(
    transcripts: TranscriptOption[] | undefined,
    transcription: Transcription | undefined,
): TranscriptOption[] {
    if (transcripts && transcripts.length > 0) return transcripts;
    if (!transcription?.text) return [];
    return [
        {
            source: transcription.source ?? "riffado",
            text: transcription.text,
            language: transcription.language,
            provider: transcription.provider,
            model: transcription.model,
            turns: transcription.turns,
            topics: transcription.topics,
        },
    ];
}

/**
 * A short hash of what a transcript's speaker labels come from, so the
 * speaker tags can tell a re-transcription from a refetch of the same text.
 */
export function transcriptFingerprint(
    transcript: TranscriptOption | undefined,
): string {
    if (!transcript) return "";
    const turns = (transcript.turns ?? [])
        .map((turn) => `${turn.speaker}|${turn.startMs}|${turn.endMs}`)
        .join("\n");
    // FNV-1a, 32 bits: collisions only cost a missed reload.
    let hash = 0x811c9dc5;
    for (const part of [transcript.text, turns]) {
        for (let index = 0; index < part.length; index++) {
            hash ^= part.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
    }
    return (hash >>> 0).toString(36);
}

/** Distinct speaker tags in first-appearance order for one transcript. */
export function transcriptSpeakerTags(
    transcript: TranscriptOption | undefined,
): TranscriptSpeakerTag[] {
    if (!transcript) return [];
    return speakerLabelsForTranscript(transcript).map((speaker) => ({
        speaker,
        label: formatSpeakerLabel(speaker),
    }));
}

export function TranscriptionPanel({
    recording,
    transcription,
    transcripts,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    onTranscriptStale,
    onSeekToTurn,
    onPlayFromTurn,
    getPlaybackMs,
    readOnly = false,
}: TranscriptionPanelProps) {
    const i18n = useExtracted();
    const summaryPresetCopy = useSummaryPresetCopy();
    const transcriptList = toTranscriptList(transcripts, transcription);
    // The Organization view of a shared recording: the one recording, its
    // summaries made with the Organization's templates.
    const view = recording.view;
    const orgView = view === "org";

    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const [transcriptExpanded, setTranscriptExpanded] = useState(true);
    const activeTranscript =
        transcriptList.find((t) => t.source === activeSource) ??
        transcriptList[0];
    const canHavePlaudSummary =
        !orgView &&
        (recording.deviceSn !== "local" ||
            transcriptList.some((candidate) => candidate.source === "plaud"));
    const speakerTags = useMemo(
        () => transcriptSpeakerTags(activeTranscript),
        [activeTranscript],
    );
    // Which transcript text is on screen: its stored version when the page
    // loaded one, else a hash of the text.
    const activeTranscriptKey = useMemo(
        () =>
            activeTranscript?.version
                ? `${activeTranscript.version.transcriptionId}@${activeTranscript.version.revision}`
                : transcriptFingerprint(activeTranscript),
        [activeTranscript],
    );
    // Topics are anchored to timed turns and written onto the transcript
    // row, by whoever may change it: its owner on the private view, the
    // organization account on the Organization view while shared.
    const canDetectTopics =
        !readOnly &&
        (activeTranscript?.source === "plaud" ||
            activeTranscript?.source === "riffado") &&
        (activeTranscript.turns?.length ?? 0) > 0;
    // Learn reads timed turns, on a transcript the viewer may change: the
    // owner's on the private view, the organization account's on the
    // Organization view (the server decides whether Learn is available).
    const canLearn =
        canDetectTopics && !isUntimed(activeTranscript?.turns ?? []);
    // Bumped when what automatic Learn held back is queued or made, so the
    // topics and the summary look for it again.
    const [followUpRevision, setFollowUpRevision] = useState(0);
    const {
        topics,
        detecting: detectingTopics,
        detect: detectTopics,
    } = useTranscriptTopics(
        recording.id,
        activeTranscript?.source,
        activeTranscript?.topics,
        canDetectTopics,
        view,
        followUpRevision,
    );
    const transcriptSectionRef = useRef<HTMLElement>(null);
    const speakerCursorRef = useRef<{
        transcript: string;
        speaker: string;
        index: number;
    } | null>(null);
    const [speakerJump, setSpeakerJump] = useState<{ index: number } | null>(
        null,
    );
    // A fresh object per jump, so jumping to the same topic twice scrolls
    // and highlights twice.
    const [topicJump, setTopicJump] = useState<{ index: number } | null>(null);
    // The ready review's proposals, shown in the transcript it was made on.
    const [learnMarks, setLearnMarks] = useState<LearnMarks | null>(null);
    // Reviews finished here: a review names speakers without a new
    // revision, so the speaker tags mount afresh to read them again.
    const [reviewsFinished, setReviewsFinished] = useState(0);
    // Speakers named from Learn's guesses, read again the same way.
    const [guessesAccepted, setGuessesAccepted] = useState(0);

    // The transcript's corrections, read edited by default. Only a Plaud or
    // Riffado transcript with stored turns has any; a mix has none.
    const correctionSource =
        (activeTranscript?.source === "plaud" ||
            activeTranscript?.source === "riffado") &&
        (activeTranscript.turns?.length ?? 0) > 0
            ? activeTranscript.source
            : null;
    const correctionsUrl = correctionSource
        ? withRecordingView(
              `/api/recordings/${recording.id}/corrections?source=${correctionSource}`,
              view,
          )
        : null;
    const [correctionsState, setCorrectionsState] = useState<{
        url: string;
        list: OverlayCorrection[];
        canUndo: boolean;
    } | null>(null);
    const [correctionsRead, setCorrectionsRead] = useState(0);
    const [showOriginal, setShowOriginal] = useState(false);
    useEffect(() => {
        if (!correctionsUrl) return;
        // Read again after a review or an undo changed them.
        void reviewsFinished;
        void correctionsRead;
        let cancelled = false;
        fetch(correctionsUrl)
            .then((response) => (response.ok ? response.json() : null))
            .then(
                (
                    body: {
                        corrections?: OverlayCorrection[];
                        canUndo?: boolean;
                    } | null,
                ) => {
                    if (cancelled) return;
                    setCorrectionsState({
                        url: correctionsUrl,
                        list: body?.corrections ?? [],
                        canUndo: body?.canUndo === true,
                    });
                },
            )
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [correctionsUrl, reviewsFinished, correctionsRead]);
    const shownCorrections =
        correctionsState && correctionsState.url === correctionsUrl
            ? correctionsState
            : null;
    const undoCorrection = useCallback(
        async (correctionId: string) => {
            const response = await fetch(
                withRecordingView(
                    `/api/recordings/${recording.id}/corrections/${correctionId}`,
                    view,
                ),
                { method: "DELETE" },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not undo the correction"),
                    ),
                );
            }
            setCorrectionsRead((count) => count + 1);
            onTranscriptStale?.();
        },
        [recording.id, view, i18n, onTranscriptStale],
    );
    const handleSelectTopic = (index: number) => {
        const topic = topics?.[index];
        if (!topic) return;
        onSeekToTurn?.(topic.fromMs);
        setTranscriptExpanded(true);
        setTopicJump({ index });
    };
    useEffect(() => {
        if (!topicJump || !transcriptExpanded) return;
        const section = transcriptSectionRef.current;
        const heading = section?.querySelector(
            `[data-topic-index="${topicJump.index}"]`,
        );
        if (section && heading instanceof HTMLElement) {
            section.scrollTo({
                top: heading.offsetTop - 8,
                behavior: "smooth",
            });
        }
        const timer = setTimeout(() => setTopicJump(null), 2000);
        return () => clearTimeout(timer);
    }, [topicJump, transcriptExpanded]);
    useEffect(() => {
        if (!speakerJump || !transcriptExpanded) return;
        const section = transcriptSectionRef.current;
        const turn = section?.querySelector(
            `[data-turn-index="${speakerJump.index}"]`,
        );
        if (section && turn instanceof HTMLElement) {
            section.scrollTo({ top: turn.offsetTop - 8, behavior: "smooth" });
        }
        const timer = setTimeout(() => setSpeakerJump(null), 2000);
        return () => clearTimeout(timer);
    }, [speakerJump, transcriptExpanded]);
    const attributionKey = activeTranscript
        ? `${recording.id}:${activeTranscript.source}`
        : "";
    const [attributionsByKey, setAttributionsByKey] = useState<
        Record<string, SpeakerAttributions>
    >({});
    const speakerAttributions = attributionsByKey[attributionKey] ?? {};
    // Labels answered "nobody known", which no guess names either.
    const [unknownByKey, setUnknownByKey] = useState<
        Record<string, ReadonlySet<string>>
    >({});
    const answeredLabels = useMemo(
        () =>
            new Set([
                ...Object.keys(speakerAttributions),
                ...(unknownByKey[attributionKey] ?? []),
            ]),
        [speakerAttributions, unknownByKey, attributionKey],
    );
    const handlePlaySpeaker = (speaker: string): boolean => {
        const turns = activeTranscript?.turns;
        if (!turns?.length || !onPlayFromTurn) return false;
        const matching = turns.flatMap((turn, index) =>
            speakerKey(turn.speaker) === speaker &&
            Number.isFinite(turn.startMs) &&
            turn.startMs >= 0
                ? [index]
                : [],
        );
        if (matching.length === 0) return false;
        const transcript = `${attributionKey}:${activeTranscriptKey}`;
        const cursor = speakerCursorRef.current;
        const nextPosition =
            cursor?.transcript === transcript && cursor.speaker === speaker
                ? (matching.indexOf(cursor.index) + 1) % matching.length
                : 0;
        const index = matching[nextPosition];
        speakerCursorRef.current = { transcript, speaker, index };
        onPlayFromTurn(turns[index].startMs);
        setTranscriptExpanded(true);
        setSpeakerJump({ index });
        return true;
    };
    const handleAttributionsChange = useCallback(
        (values: SpeakerAttributions) => {
            setAttributionsByKey((current) => ({
                ...current,
                [attributionKey]: values,
            }));
        },
        [attributionKey],
    );
    const handleUnknownLabelsChange = useCallback(
        (labels: ReadonlySet<string>) => {
            setUnknownByKey((current) => ({
                ...current,
                [attributionKey]: labels,
            }));
        },
        [attributionKey],
    );

    const defaultSummarySource: SummarySource =
        activeTranscript?.source === "plaud" ? "plaud" : "riffado";
    const [summarySelection, setSummarySelection] = useState<{
        recordingId: string;
        source: SummarySource;
    }>({ recordingId: "", source: "riffado" });
    const summarySource =
        summarySelection.recordingId === recording.id
            ? summarySelection.source
            : defaultSummarySource;
    const summaryTranscript = transcriptList.find(
        (candidate) => candidate.source === summarySource,
    );
    const summarySpeakerTags = useMemo(
        () => transcriptSpeakerTags(summaryTranscript),
        [summaryTranscript],
    );
    const summaryAttributionKey = summaryTranscript
        ? `${recording.id}:${summaryTranscript.source}`
        : "";
    const summarySpeakerAttributions =
        attributionsByKey[summaryAttributionKey] ?? {};

    useEffect(() => {
        if (!summaryTranscript || summaryAttributionKey === attributionKey) {
            return;
        }
        const controller = new AbortController();
        void fetch(
            withRecordingView(
                `/api/recordings/${recording.id}/speakers?source=${encodeURIComponent(summaryTranscript.source)}`,
                view,
            ),
            { signal: controller.signal },
        )
            .then(async (response) => {
                if (!response.ok) return null;
                return (await response.json()) as {
                    speakers?: SpeakerResponseRow[];
                };
            })
            .then((body) => {
                if (!body) return;
                setAttributionsByKey((current) => ({
                    ...current,
                    [summaryAttributionKey]: confirmedAttributions(
                        body.speakers,
                    ),
                }));
            })
            .catch(() => {});
        return () => controller.abort();
    }, [
        attributionKey,
        recording.id,
        summaryAttributionKey,
        summaryTranscript,
        view,
    ]);

    const {
        summaryData,
        isSummarizing,
        summaryProgress,
        summaryElapsedMs,
        summaryExpanded,
        setSummaryExpanded,
        summaryPreset,
        setSummaryPreset,
        summaryPromptOptions,
        handleSummarize,
        recheckSummary,
    } = useTranscriptionSummary({
        recordingId: recording?.id,
        summarySource,
        transcriptionText: summaryTranscript?.text,
        view,
    });

    // The title, summary and topics automatic Learn held back are made by
    // jobs a finished review queues: followed here, since nothing the page
    // started makes them.
    const {
        held: heldForReview,
        correcting,
        follow: followReleased,
    } = useLearnFollowUps({
        recordingId: recording.id,
        enabled: canLearn && !orgView,
        onChange: () => {
            setFollowUpRevision((count) => count + 1);
            // The correction pass may have corrected it meanwhile.
            setCorrectionsRead((count) => count + 1);
            recheckSummary();
            onTranscriptStale?.();
        },
    });
    const handleReviewFinished = useCallback(() => {
        setReviewsFinished((count) => count + 1);
        followReleased();
        onTranscriptStale?.();
    }, [followReleased, onTranscriptStale]);

    // Null for a single-pass summary, so the badge simply does not
    // render. Derived rather than stored on the client: the shape comes
    // from POST and GET alike, so a reload shows the same badge.
    const baseMultiPassBadge = describeMultiPass(summaryData?.multiPass);
    const multiPassBadge = (() => {
        const provenance = summaryData?.multiPass;
        if (!baseMultiPassBadge || !provenance) return null;
        const { roundsRequested, passesUsed, merged } = provenance;
        let title: string;
        if (merged && passesUsed === roundsRequested) {
            title = i18n("{used} of {requested} passes merged", {
                used: String(passesUsed),
                requested: String(roundsRequested),
            });
        } else if (passesUsed === 0) {
            title = i18n(
                "No pass returned usable output; showing the raw reply of {requested}.",
                { requested: String(roundsRequested) },
            );
        } else if (!merged && passesUsed === 1) {
            title = i18n(
                "Only 1 of {requested} passes succeeded, so it is shown unmerged.",
                { requested: String(roundsRequested) },
            );
        } else if (!merged) {
            title = i18n(
                "{used} of {requested} passes succeeded, but the merge failed; showing the most complete single pass.",
                {
                    used: String(passesUsed),
                    requested: String(roundsRequested),
                },
            );
        } else {
            title = i18n(
                "{used} of {requested} passes succeeded and were merged.",
                {
                    used: String(passesUsed),
                    requested: String(roundsRequested),
                },
            );
        }
        return {
            ...baseMultiPassBadge,
            label: i18n("multi-pass · {passes}", {
                passes:
                    passesUsed === roundsRequested
                        ? String(roundsRequested)
                        : `${passesUsed}/${roundsRequested}`,
            }),
            title,
        };
    })();
    const summaryStatusLabel = !summaryProgress
        ? i18n("Generating summary…")
        : summaryProgress.phase === "merging"
          ? i18n("Merging {count, plural, one {# pass} other {# passes}}…", {
                count: summaryProgress.total,
            })
          : i18n("Summarizing — {completed}/{total} passes", {
                completed: String(summaryProgress.completed),
                total: String(summaryProgress.total),
            });
    const summaryStatus =
        summaryElapsedMs > 0
            ? `${summaryStatusLabel} · ${formatElapsed(summaryElapsedMs)}`
            : summaryStatusLabel;
    const summarySpeakerNumberOffset = useMemo(() => {
        if (!summaryData) return 0;
        return inferSummarySpeakerNumberOffset(
            [
                summaryData.summary,
                ...(summaryData.keyPoints ?? []),
                ...(summaryData.actionItems ?? []),
            ].join("\n"),
            summarySpeakerTags.map((speaker) => speaker.speaker),
        );
    }, [summaryData, summarySpeakerTags]);

    return (
        <div className="space-y-4">
            {correcting && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {i18n(
                        "Learn is reading the transcript again with the Almanac to correct misheard words.",
                    )}
                </p>
            )}
            {learnMarks &&
                canLearn &&
                activeTranscript &&
                activeTranscript.source !== "mixed" && (
                    <SpeakerGuesses
                        key={`${recording.id}:${view ?? "private"}:${activeTranscript.source}:${activeTranscriptKey}`}
                        recordingId={recording.id}
                        source={activeTranscript.source}
                        view={view}
                        shownVersion={activeTranscript.version}
                        marks={learnMarks}
                        answeredLabels={answeredLabels}
                        onAccepted={() =>
                            setGuessesAccepted((count) => count + 1)
                        }
                        onSeek={onSeekToTurn}
                    />
                )}
            {/* Transcription Card */}
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="size-5" />{" "}
                            {i18n("Transcription")}
                        </CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                            {transcriptList.length > 1 && activeTranscript && (
                                <SourceSwitcher
                                    ariaLabel={i18n("Transcript source")}
                                    sources={transcriptList.map(
                                        (candidate) => candidate.source,
                                    )}
                                    value={activeTranscript.source}
                                    onSelect={setActiveSource}
                                />
                            )}
                            {activeTranscript?.text && (
                                <MarkdownActions
                                    recordingId={recording.id}
                                    kind="transcript"
                                    source={activeTranscript.source}
                                    view={view}
                                />
                            )}
                            {activeTranscript?.text && !readOnly && (
                                <Button
                                    onClick={() =>
                                        onTranscribe(activeTranscript.source)
                                    }
                                    size="sm"
                                    variant="outline"
                                    // No audio, nothing to re-transcribe
                                    // from. Both the server route and the
                                    // browser one would only fetch a 410.
                                    disabled={
                                        isTranscribing || recording.audioReaped
                                    }
                                    title={
                                        recording.audioReaped
                                            ? i18n(
                                                  "Audio was removed by your retention policy",
                                              )
                                            : undefined
                                    }
                                >
                                    <RefreshCw className="size-4 mr-2" />{" "}
                                    {i18n("Re-transcribe")}
                                </Button>
                            )}
                            {!activeTranscript?.text &&
                                !isTranscribing &&
                                !readOnly && (
                                    <>
                                        <Button
                                            onClick={() => onTranscribe()}
                                            size="sm"
                                            disabled={
                                                isTranscribing ||
                                                recording.audioReaped
                                            }
                                            title={
                                                recording.audioReaped
                                                    ? i18n(
                                                          "Audio was removed by your retention policy",
                                                      )
                                                    : undefined
                                            }
                                        >
                                            <Sparkles className="size-4 mr-2" />{" "}
                                            {i18n("Transcribe")}
                                        </Button>
                                        {!orgView && (
                                            <TranscribeInBrowserButton
                                                recordingId={recording.id}
                                                disabled={
                                                    isTranscribing ||
                                                    recording.audioReaped
                                                }
                                                onComplete={
                                                    // Falling back to `onTranscribe` here
                                                    // would kick off a redundant SERVER
                                                    // transcription right after a
                                                    // successful browser one, possibly
                                                    // overwriting it. Callers that care
                                                    // about refreshing after a browser
                                                    // transcription must pass
                                                    // `onTranscribeComplete` explicitly.
                                                    onTranscribeComplete ??
                                                    (() => {})
                                                }
                                            />
                                        )}
                                    </>
                                )}
                        </div>
                    </div>
                    {activeTranscript && speakerTags.length > 0 && (
                        <SpeakerTags
                            // Another recording, view, source or text is
                            // another transcript to name: mount afresh, so
                            // nothing of the last one's state, or its late
                            // answers, reaches this one.
                            key={`${recording.id}:${view ?? "private"}:${activeTranscript.source}:${activeTranscriptKey}:${reviewsFinished}:${guessesAccepted}`}
                            recordingId={recording.id}
                            source={activeTranscript.source}
                            speakers={speakerTags}
                            attributions={speakerAttributions}
                            onAttributionsChange={handleAttributionsChange}
                            view={view}
                            onSeek={onSeekToTurn}
                            onPlaySpeaker={
                                onPlayFromTurn && activeTranscript.turns?.length
                                    ? handlePlaySpeaker
                                    : undefined
                            }
                            shownVersion={activeTranscript.version}
                            onStale={onTranscriptStale}
                            onUnknownLabelsChange={handleUnknownLabelsChange}
                            readOnly={readOnly}
                        />
                    )}
                </CardHeader>
                <CardContent>
                    {isTranscribing ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin size-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                            <p className="text-sm text-muted-foreground">
                                {i18n("Transcribing audio…")}
                            </p>
                        </div>
                    ) : activeTranscript?.text ? (
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                                <button
                                    type="button"
                                    aria-expanded={transcriptExpanded}
                                    onClick={() =>
                                        setTranscriptExpanded(
                                            !transcriptExpanded,
                                        )
                                    }
                                    className="flex items-center gap-1 text-sm font-medium transition-colors hover:text-primary"
                                >
                                    {transcriptExpanded ? (
                                        <ChevronUp className="size-4" />
                                    ) : (
                                        <ChevronDown className="size-4" />
                                    )}
                                    {transcriptExpanded
                                        ? i18n("Collapse transcript")
                                        : i18n("Expand transcript")}
                                </button>
                                <TranscriptTopicsMenu
                                    topics={topics}
                                    canDetect={canDetectTopics}
                                    waitingForReview={heldForReview}
                                    detecting={detectingTopics}
                                    onDetect={() => void detectTopics()}
                                    onSelect={handleSelectTopic}
                                    getPlaybackMs={getPlaybackMs}
                                />
                                {(shownCorrections?.list.length ?? 0) > 0 && (
                                    <button
                                        type="button"
                                        aria-pressed={showOriginal}
                                        onClick={() =>
                                            setShowOriginal(!showOriginal)
                                        }
                                        className="text-sm font-medium transition-colors hover:text-primary"
                                    >
                                        {showOriginal
                                            ? i18n("Show edited")
                                            : i18n("Show original")}
                                    </button>
                                )}
                                {canLearn && activeTranscript && (
                                    <LearnReview
                                        // Another recording, view, source
                                        // or revision is another review.
                                        key={`${recording.id}:${view ?? "private"}:${activeTranscript.source}:${activeTranscriptKey}`}
                                        recordingId={recording.id}
                                        view={view}
                                        source={
                                            activeTranscript.source === "plaud"
                                                ? "plaud"
                                                : "riffado"
                                        }
                                        turns={activeTranscript.turns ?? []}
                                        onSeek={onSeekToTurn}
                                        onFinished={handleReviewFinished}
                                        onMarks={setLearnMarks}
                                    />
                                )}
                            </div>
                            {transcriptExpanded && (
                                <div className="space-y-4">
                                    <section
                                        ref={transcriptSectionRef}
                                        aria-label={i18n("Transcript content")}
                                        className="relative max-h-96 overflow-y-auto rounded-lg bg-muted p-4"
                                    >
                                        <TranscriptView
                                            text={activeTranscript.text}
                                            source={activeTranscript.source}
                                            model={activeTranscript.model}
                                            storedTurns={activeTranscript.turns}
                                            speakerAttributions={
                                                speakerAttributions
                                            }
                                            onSeekToTurn={onSeekToTurn}
                                            topics={topics}
                                            highlightedTopic={
                                                topicJump?.index ?? null
                                            }
                                            highlightedTurnIndex={
                                                speakerJump?.index ?? null
                                            }
                                            // A mix is not the transcript
                                            // Learn read.
                                            corrections={
                                                shownCorrections &&
                                                !showOriginal
                                                    ? {
                                                          list: shownCorrections.list,
                                                          canUndo:
                                                              shownCorrections.canUndo &&
                                                              !readOnly,
                                                          onUndo: (id) =>
                                                              void undoCorrection(
                                                                  id,
                                                              ),
                                                      }
                                                    : null
                                            }
                                            learnMarks={
                                                canLearn &&
                                                activeTranscript.source !==
                                                    "mixed"
                                                    ? learnMarks
                                                    : null
                                            }
                                        />
                                    </section>
                                    <div className="flex items-center gap-4 border-t pt-2 text-xs text-muted-foreground">
                                        <span className="rounded bg-muted px-2 py-0.5 font-medium">
                                            {activeTranscript.source === "plaud"
                                                ? "Plaud"
                                                : activeTranscript.source ===
                                                    "mixed"
                                                  ? i18n("Mix")
                                                  : i18n("Custom")}
                                        </span>
                                        {activeTranscript.provider && (
                                            <span className="rounded bg-muted px-2 py-0.5">
                                                {activeTranscript.provider}
                                            </span>
                                        )}
                                        {activeTranscript.model && (
                                            <span className="rounded bg-muted px-2 py-0.5 font-mono">
                                                {activeTranscript.model}
                                            </span>
                                        )}
                                        {activeTranscript.language && (
                                            <div className="flex items-center gap-1">
                                                <Languages className="size-3" />
                                                <span>
                                                    {i18n("Language:")}{" "}
                                                    {activeTranscript.language}
                                                </span>
                                            </div>
                                        )}
                                        <div>
                                            {activeTranscript.text.trim()
                                                ? activeTranscript.text
                                                      .trim()
                                                      .split(/\s+/).length
                                                : 0}{" "}
                                            {i18n("words")}
                                        </div>
                                        <div>
                                            {activeTranscript.text.length}{" "}
                                            {i18n("characters")}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 text-center">
                            <FileText className="size-10 text-muted-foreground mb-3" />
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "No transcription yet. Use the Transcribe button above.",
                                )}
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Summary Card -- only show when a transcript exists */}
            {activeTranscript?.text && (
                <Card>
                    <CardHeader>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
                            <CardTitle className="flex items-center gap-2">
                                <ListChecks className="size-5" />{" "}
                                {i18n("Summary")}
                            </CardTitle>
                            <div className="flex flex-wrap items-center gap-2">
                                {canHavePlaudSummary && (
                                    <SourceSwitcher
                                        ariaLabel={i18n("Summary source")}
                                        sources={["plaud", "riffado"]}
                                        value={summarySource}
                                        onSelect={(source) =>
                                            setSummarySelection({
                                                recordingId: recording.id,
                                                source:
                                                    source === "plaud"
                                                        ? "plaud"
                                                        : "riffado",
                                            })
                                        }
                                    />
                                )}
                                {summaryData?.summary && (
                                    <MarkdownActions
                                        recordingId={recording.id}
                                        kind="summary"
                                        source={summarySource}
                                        view={view}
                                    />
                                )}
                                {summarySource === "riffado" &&
                                    !orgView &&
                                    !readOnly &&
                                    !isSummarizing && (
                                        <Select
                                            value={summaryPreset}
                                            onValueChange={setSummaryPreset}
                                        >
                                            <SelectTrigger className="w-[160px] h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {summaryPromptOptions.map(
                                                    (preset) => (
                                                        <SelectItem
                                                            key={preset.id}
                                                            value={preset.id}
                                                        >
                                                            {preset.name ??
                                                                summaryPresetCopy[
                                                                    preset.id as keyof typeof summaryPresetCopy
                                                                ]?.name ??
                                                                preset.id}
                                                        </SelectItem>
                                                    ),
                                                )}
                                            </SelectContent>
                                        </Select>
                                    )}
                                {summarySource === "riffado" && !readOnly && (
                                    <Button
                                        onClick={handleSummarize}
                                        size="sm"
                                        variant={
                                            summaryData ? "outline" : "default"
                                        }
                                        disabled={
                                            isSummarizing ||
                                            (!summaryTranscript &&
                                                !(
                                                    orgView &&
                                                    transcriptList.length > 0
                                                ))
                                        }
                                    >
                                        {isSummarizing ? (
                                            <>
                                                <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                                                {i18n("Generating…")}
                                            </>
                                        ) : summaryData ? (
                                            <>
                                                <RefreshCw className="size-4 mr-2" />{" "}
                                                {i18n("Re-summarize")}
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles className="size-4 mr-2" />{" "}
                                                {i18n("Summarize")}
                                            </>
                                        )}
                                    </Button>
                                )}
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {isSummarizing ? (
                            <div className="flex flex-col items-center justify-center py-8">
                                <Loader2 className="size-8 animate-spin text-primary mb-4" />
                                <p className="text-sm text-muted-foreground">
                                    {summaryStatus}
                                </p>
                            </div>
                        ) : summaryData?.summary ? (
                            <div className="space-y-4">
                                <button
                                    type="button"
                                    aria-expanded={summaryExpanded}
                                    onClick={() =>
                                        setSummaryExpanded(!summaryExpanded)
                                    }
                                    className="flex items-center gap-1 text-sm font-medium hover:text-primary transition-colors"
                                >
                                    {summaryExpanded ? (
                                        <ChevronUp className="size-4" />
                                    ) : (
                                        <ChevronDown className="size-4" />
                                    )}
                                    {summaryExpanded
                                        ? i18n("Collapse summary")
                                        : i18n("Expand summary")}
                                </button>

                                {summaryExpanded && (
                                    <section
                                        aria-label={i18n("Summary content")}
                                        className="max-h-96 space-y-4 overflow-y-auto pr-2"
                                    >
                                        {/* Summary text */}
                                        <div className="bg-muted rounded-lg p-4 text-sm">
                                            <Markdown
                                                speakerAttributions={
                                                    summarySpeakerAttributions
                                                }
                                                speakerNumberOffset={
                                                    summarySpeakerNumberOffset
                                                }
                                            >
                                                {summaryData.summary}
                                            </Markdown>
                                        </div>

                                        {/* Key points */}
                                        {summaryData.keyPoints &&
                                            summaryData.keyPoints.length >
                                                0 && (
                                                <div>
                                                    <h4 className="text-sm font-medium mb-2">
                                                        {i18n("Key Points")}
                                                    </h4>
                                                    <ul className="space-y-1">
                                                        {summaryData.keyPoints.map(
                                                            (point) => {
                                                                const key = `kp-${point.slice(0, 32)}`;
                                                                return (
                                                                    <li
                                                                        key={
                                                                            key
                                                                        }
                                                                        className="text-sm text-muted-foreground flex items-start gap-2"
                                                                    >
                                                                        <span className="text-primary mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                                                                        <Markdown
                                                                            inline
                                                                            speakerAttributions={
                                                                                summarySpeakerAttributions
                                                                            }
                                                                            speakerNumberOffset={
                                                                                summarySpeakerNumberOffset
                                                                            }
                                                                        >
                                                                            {
                                                                                point
                                                                            }
                                                                        </Markdown>
                                                                    </li>
                                                                );
                                                            },
                                                        )}
                                                    </ul>
                                                </div>
                                            )}

                                        {/* Action items */}
                                        {summaryData.actionItems &&
                                            summaryData.actionItems.length >
                                                0 && (
                                                <div>
                                                    <h4 className="text-sm font-medium mb-2">
                                                        {i18n("Action Items")}
                                                    </h4>
                                                    <ul className="space-y-1">
                                                        {summaryData.actionItems.map(
                                                            (item) => {
                                                                const key = `ai-${item.slice(0, 32)}`;
                                                                return (
                                                                    <li
                                                                        key={
                                                                            key
                                                                        }
                                                                        className="text-sm text-muted-foreground flex items-start gap-2"
                                                                    >
                                                                        <ListChecks className="size-3.5 mt-0.5 text-primary shrink-0" />
                                                                        <Markdown
                                                                            inline
                                                                            speakerAttributions={
                                                                                summarySpeakerAttributions
                                                                            }
                                                                            speakerNumberOffset={
                                                                                summarySpeakerNumberOffset
                                                                            }
                                                                        >
                                                                            {
                                                                                item
                                                                            }
                                                                        </Markdown>
                                                                    </li>
                                                                );
                                                            },
                                                        )}
                                                    </ul>
                                                </div>
                                            )}

                                        {/* Summary metadata */}
                                        <div className="flex items-center border-t pt-2">
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                <span className="px-2 py-0.5 rounded bg-muted font-medium">
                                                    {summarySource === "plaud"
                                                        ? "Plaud"
                                                        : i18n("Custom")}
                                                </span>
                                                {summaryData.provider && (
                                                    <span className="px-2 py-0.5 rounded bg-muted">
                                                        {summaryData.provider}
                                                    </span>
                                                )}
                                                {summaryData.model && (
                                                    <span className="px-2 py-0.5 rounded bg-muted font-mono">
                                                        {summaryData.model}
                                                    </span>
                                                )}
                                                {summaryData.stale &&
                                                    summarySource ===
                                                        "riffado" && (
                                                        <span className="flex items-center gap-2 rounded bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                                                            {i18n(
                                                                "May contain stale names or terms",
                                                            )}
                                                            {!readOnly && (
                                                                <button
                                                                    type="button"
                                                                    className="font-medium underline-offset-2 hover:underline disabled:opacity-50"
                                                                    disabled={
                                                                        isSummarizing
                                                                    }
                                                                    onClick={
                                                                        handleSummarize
                                                                    }
                                                                >
                                                                    {i18n(
                                                                        "Regenerate",
                                                                    )}
                                                                </button>
                                                            )}
                                                        </span>
                                                    )}
                                                {multiPassBadge && (
                                                    <span
                                                        className={
                                                            multiPassBadge.degraded
                                                                ? "px-2 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                                                : "px-2 py-0.5 rounded bg-muted"
                                                        }
                                                        title={
                                                            multiPassBadge.title
                                                        }
                                                    >
                                                        {multiPassBadge.label}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </section>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                                <ListChecks className="size-10 text-muted-foreground mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    {summarySource === "plaud"
                                        ? i18n(
                                              "No Plaud summary has been imported. It will appear after Plaud sync when available.",
                                          )
                                        : summaryTranscript && heldForReview
                                          ? i18n(
                                                'The summary waits for your Learn review, so it reads the corrected transcript. Finish the review, or click "Summarize" to make it now.',
                                            )
                                          : summaryTranscript
                                            ? i18n(
                                                  'No custom summary yet. Click "Summarize" to generate one.',
                                              )
                                            : i18n(
                                                  "A custom transcript is required before generating a custom summary.",
                                              )}
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
