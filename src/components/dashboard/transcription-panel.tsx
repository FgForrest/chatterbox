"use client";

import {
    ChevronDown,
    ChevronUp,
    FileText,
    Languages,
    Loader2,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MarkdownActions } from "@/components/dashboard/markdown-actions";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { TranscriptChapterBar } from "@/components/dashboard/transcript-chapter-bar";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { HelpLink } from "@/components/help/help-button";
import type { LearnMarks } from "@/components/learn/learn-marks";
import { LearnReview } from "@/components/learn/learn-review";
import { SpeakerGuesses } from "@/components/learn/speaker-guesses";
import { SpeakerAccentContext } from "@/components/people/speaker-accent-context";
import {
    confirmedAttributions,
    type SpeakerResponseRow,
    SpeakerTags,
    type TranscriptSpeakerTag,
} from "@/components/people/speaker-tags";
import {
    useWorkflowWidgetOpen,
    WorkflowWidget,
    WorkflowWidgetLine,
} from "@/components/pipeline/workflow-widget";
import type { PlayAtTarget } from "@/components/playback/play-at-button";
import { usePlayback } from "@/components/playback/playback-context";
import { useProductName } from "@/components/product-name-provider";
import { SourceSwitcher } from "@/components/source-switcher";
import { SummaryWidget } from "@/components/summary/summary-widget";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLearnFollowUps } from "@/hooks/use-learn-follow-ups";
import { useTranscriptTopics } from "@/hooks/use-transcript-topics";
import type { SummarySource } from "@/hooks/use-transcription-summary";
import { getApiErrorMessage } from "@/lib/api-errors";
import { isUntimed } from "@/lib/knowledge/correction-anchors";
import { speakerPositions } from "@/lib/knowledge/speaker-groups";
import {
    speakerKey,
    speakerLabelsForTranscript,
} from "@/lib/knowledge/speaker-label-rules";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";
import type { OverlayCorrection } from "@/lib/learn/render";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";
import { withRecordingView } from "@/lib/sharing/view";
import type { TranscriptTopic } from "@/lib/topics/timeline";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import { preferredTranscript } from "@/lib/transcription/preferred-source";
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
    onTranscribe: (attributionSource?: string, retranscribe?: boolean) => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    /**
     * Reload the page's transcripts: the one on screen was replaced, e.g.
     * re-transcribed in another tab.
     */
    onTranscriptStale?: () => void;
    /**
     * The viewer is neither the owner nor a curator of the shared recording.
     * Speakers are shown read-only, and no transcription, summary or topic
     * detection is offered.
     */
    readOnly?: boolean;
    shared?: boolean;
    processing?: ItemProcessingPresentation | null;
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
    readOnly = false,
    shared = false,
    processing = null,
}: TranscriptionPanelProps) {
    const playback = usePlayback();
    const i18n = useExtracted();
    const name = useProductName();
    const transcriptList = toTranscriptList(transcripts, transcription);
    const serverTranscriptionJob = processing?.jobs.transcription ?? null;
    const serverHasTranscript = processing?.outputs.transcript === true;
    const transcriptionRunning =
        isTranscribing || serverTranscriptionJob !== null;
    const knownTranscriptExists =
        serverHasTranscript || recording.hasTranscript === true;
    const widgets = processing ? deriveWorkflowWidgets(processing) : null;
    // The Organization view of a shared recording: the one recording, its
    // summaries made with the Organization's templates.
    const view = shared ? "org" : recording.view;
    const orgView = view === "org";

    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const [transcriptExpanded, setTranscriptExpanded] = useState(true);
    const [workflowTranscriptExpanded, setWorkflowTranscriptExpanded] =
        useState(false);
    const activeTranscript =
        transcriptList.find((t) => t.source === activeSource) ??
        transcriptList[0];
    const transcriptOpen = widgets?.workflowVisible
        ? !widgets.transcript.collapsed || workflowTranscriptExpanded
        : transcriptExpanded;
    const transcriptQuiet = Boolean(
        widgets?.workflowVisible &&
            widgets.transcript.collapsed &&
            !workflowTranscriptExpanded,
    );
    const transcriptLine =
        transcriptQuiet ||
        Boolean(transcriptionRunning && widgets?.transcript.frame === "dialog");
    const transcriptWidgetId = `recording-transcription-${recording.id}`;
    let transcriptSourceLabel = name;
    if (activeTranscript?.source === "plaud") transcriptSourceLabel = "Plaud";
    if (activeTranscript?.source === "mixed") {
        transcriptSourceLabel = i18n("Mix");
    }
    const folderName =
        processing?.placements[0]?.name ?? processing?.intents[0]?.name;
    const startTranscription = (source?: string, retranscribe = false) => {
        onTranscribe(source, retranscribe);
    };
    const previousServerTranscriptionJob = useRef(serverTranscriptionJob);
    const requestedServerTranscriptReload = useRef(false);
    const transcriptMissing = !transcriptList.some(
        (candidate) => candidate.text,
    );
    useEffect(() => {
        const serverJobFinished =
            previousServerTranscriptionJob.current !== null &&
            serverTranscriptionJob === null;
        previousServerTranscriptionJob.current = serverTranscriptionJob;
        if (serverTranscriptionJob !== null) {
            requestedServerTranscriptReload.current = false;
        }
        const shouldReload =
            !isTranscribing &&
            serverTranscriptionJob === null &&
            (serverJobFinished || (serverHasTranscript && transcriptMissing));
        if (shouldReload && !requestedServerTranscriptReload.current) {
            requestedServerTranscriptReload.current = true;
            onTranscriptStale?.();
        }
        if (!transcriptMissing) {
            requestedServerTranscriptReload.current = false;
        }
    }, [
        isTranscribing,
        onTranscriptStale,
        serverHasTranscript,
        serverTranscriptionJob,
        transcriptMissing,
    ]);
    const canHavePlaudSummary =
        recording.view !== "org" &&
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
        playback?.seek(topic.fromMs);
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
                top:
                    section.scrollTop +
                    heading.getBoundingClientRect().top -
                    section.getBoundingClientRect().top -
                    (section.querySelector<HTMLElement>("[data-chapter-bar]")
                        ?.offsetHeight ?? 0) -
                    8,
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
            section.scrollTo({
                top:
                    section.scrollTop +
                    turn.getBoundingClientRect().top -
                    section.getBoundingClientRect().top -
                    (section.querySelector<HTMLElement>("[data-chapter-bar]")
                        ?.offsetHeight ?? 0) -
                    8,
                behavior: "smooth",
            });
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

    const nextSpeakerTurn = (
        voices: string | readonly string[],
        once = false,
    ): PlayAtTarget | null => {
        const turns = activeTranscript?.turns;
        if (!turns?.length || !playback) return null;
        const labels = new Set(
            (typeof voices === "string" ? [voices] : voices).map(speakerKey),
        );
        const speaker = JSON.stringify([...labels].sort());
        const matching = turns.flatMap((turn, index) =>
            labels.has(speakerKey(turn.speaker)) &&
            Number.isFinite(turn.startMs) &&
            turn.startMs >= 0
                ? [index]
                : [],
        );
        matching.sort((a, b) => turns[a].startMs - turns[b].startMs || a - b);
        if (matching.length === 0) return null;
        const transcript = `${attributionKey}:${activeTranscriptKey}`;
        const cursor = speakerCursorRef.current;
        const nextPosition =
            cursor?.transcript === transcript && cursor.speaker === speaker
                ? (matching.indexOf(cursor.index) + 1) % matching.length
                : 0;
        const index = matching[nextPosition];
        speakerCursorRef.current = { transcript, speaker, index };
        const { startMs, endMs } = turns[index];
        setTranscriptExpanded(true);
        setSpeakerJump({ index });
        return {
            ms: startMs,
            endMs:
                Number.isFinite(endMs) && endMs > startMs ? endMs : undefined,
            untilMs:
                once && Number.isFinite(endMs) && endMs > startMs
                    ? endMs
                    : undefined,
        };
    };
    const accentPositions = useMemo(
        () =>
            speakerPositions(
                speakerTags.map(({ speaker }) => speaker),
                speakerAttributions,
            ),
        [speakerTags, speakerAttributions],
    );
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
    const summaryTranscript =
        summarySource === "riffado"
            ? preferredTranscript(transcriptList)
            : transcriptList.find((candidate) => candidate.source === "plaud");
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

    // The title, summary and topics automatic Learn held back are made by
    // jobs a finished review queues: followed here, since nothing the page
    // started makes them.
    const {
        held: heldForReview,
        correcting,
        follow: followReleased,
    } = useLearnFollowUps({
        recordingId: recording.id,
        enabled: canLearn && recording.isOwn !== false,
        onChange: () => {
            setFollowUpRevision((count) => count + 1);
            // The correction pass may have corrected it meanwhile.
            setCorrectionsRead((count) => count + 1);
            onTranscriptStale?.();
        },
    });
    const learnSummaryHold = !heldForReview
        ? null
        : processing?.latestLearnRun?.status === "queued" ||
            processing?.latestLearnRun?.status === "running"
          ? "running"
          : correcting ||
              (processing?.phases.learn?.state === "running" &&
                  processing.phases.learn.reason === "correcting")
            ? "correcting"
            : (processing?.learnFindingsWaiting ?? 0) > 0
              ? "review"
              : null;
    const handleReviewFinished = useCallback(() => {
        setReviewsFinished((count) => count + 1);
        followReleased();
        onTranscriptStale?.();
    }, [followReleased, onTranscriptStale]);

    useWorkflowWidgetOpen(
        (!widgets || widgets.transcript.visible) && !transcriptLine
            ? transcriptWidgetId
            : undefined,
    );
    const transcriptFooter = activeTranscript
        ? {
              status: (
                  <div className="flex flex-wrap items-center gap-4 text-xs">
                      <span className="rounded bg-muted px-2 py-0.5 font-medium">
                          {activeTranscript.source === "plaud"
                              ? "Plaud"
                              : activeTranscript.source === "mixed"
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
                          <span className="flex items-center gap-1">
                              <Languages className="size-3" />
                              <span>
                                  {i18n("Language:")}{" "}
                                  {activeTranscript.language}
                              </span>
                          </span>
                      )}
                      <span>
                          {activeTranscript.text.trim()
                              ? activeTranscript.text.trim().split(/\s+/).length
                              : 0}{" "}
                          {i18n("words")}
                      </span>
                      <span>
                          {activeTranscript.text.length} {i18n("characters")}
                      </span>
                  </div>
              ),
              actions: null,
          }
        : undefined;

    return (
        <div className="@container/transcription min-w-0 flex flex-col gap-4">
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
                        key={`learn:${recording.id}:${view ?? "private"}:${activeTranscript.source}:${activeTranscriptKey}`}
                        recordingId={recording.id}
                        source={activeTranscript.source}
                        view={view}
                        shownVersion={activeTranscript.version}
                        marks={learnMarks}
                        answeredLabels={answeredLabels}
                        onAccepted={() =>
                            setGuessesAccepted((count) => count + 1)
                        }
                    />
                )}
            {(!widgets || widgets.transcript.visible) && (
                <WorkflowWidget
                    id={transcriptWidgetId}
                    frame="inline"
                    collapsed={
                        Boolean(activeTranscript?.text) &&
                        !transcriptOpen &&
                        !transcriptionRunning
                    }
                    onOpenChange={(next) => {
                        if (widgets?.workflowVisible)
                            setWorkflowTranscriptExpanded(next);
                        else setTranscriptExpanded(next);
                    }}
                    inlineLine={
                        transcriptLine ? (
                            <WorkflowWidgetLine
                                title={i18n("Transcription")}
                                facts={
                                    transcriptionRunning
                                        ? i18n("Transcribing audio…")
                                        : transcriptSourceLabel
                                }
                                icon={<FileText className="size-4" />}
                                tone={widgets?.transcript.tone ?? "quiet"}
                                working={transcriptionRunning}
                                expanded={
                                    transcriptionRunning ? undefined : false
                                }
                                onExpand={
                                    transcriptionRunning
                                        ? undefined
                                        : () =>
                                              setWorkflowTranscriptExpanded(
                                                  true,
                                              )
                                }
                                expandLabel={
                                    transcriptionRunning
                                        ? undefined
                                        : i18n("View transcript")
                                }
                                onOpen={() => {
                                    setWorkflowTranscriptExpanded(true);
                                }}
                            />
                        ) : undefined
                    }
                    tone={widgets?.transcript.tone ?? "quiet"}
                    bodyClassName="space-y-3"
                    title={i18n("Transcription")}
                    helpLink={
                        <HelpLink
                            topic="transcripts"
                            label={i18n("reading a transcript")}
                        />
                    }
                    footer={transcriptFooter}
                    headerAction={
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            {activeTranscript?.text && !readOnly && (
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            aria-label={i18n("Re-transcribe")}
                                            className="@max-[560px]/transcription:size-8 @max-[560px]/transcription:p-0"
                                            disabled={
                                                transcriptionRunning ||
                                                recording.audioReaped
                                            }
                                            title={
                                                recording.audioReaped
                                                    ? i18n(
                                                          "Audio was removed by your retention policy",
                                                      )
                                                    : i18n("Re-transcribe")
                                            }
                                        >
                                            <RefreshCw className="size-4 mr-2 @max-[560px]/transcription:mr-0" />
                                            <span className="@max-[560px]/transcription:hidden">
                                                {i18n("Re-transcribe")}
                                            </span>
                                        </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>
                                                {i18n(
                                                    "Re-transcribe this recording?",
                                                )}
                                            </AlertDialogTitle>
                                            <AlertDialogDescription>
                                                {i18n(
                                                    "This replaces the transcript, then regenerates the summary, title, and topics, and runs Learn again. It also makes a paid call to your transcription provider.",
                                                )}
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>
                                                {i18n("Cancel")}
                                            </AlertDialogCancel>
                                            <AlertDialogAction
                                                onClick={() =>
                                                    startTranscription(
                                                        activeTranscript.source,
                                                        true,
                                                    )
                                                }
                                            >
                                                {i18n("Re-transcribe")}
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                            )}
                            {transcriptList.length > 1 && activeTranscript && (
                                <>
                                    <div className="hidden @min-[560px]/transcription:block">
                                        <SourceSwitcher
                                            ariaLabel={i18n(
                                                "Transcript source",
                                            )}
                                            sources={transcriptList.map(
                                                (candidate) => candidate.source,
                                            )}
                                            value={activeTranscript.source}
                                            onSelect={setActiveSource}
                                        />
                                    </div>
                                    <div className="@min-[560px]/transcription:hidden">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    aria-label={i18n(
                                                        "Transcript source",
                                                    )}
                                                    title={i18n(
                                                        "Transcript source",
                                                    )}
                                                >
                                                    <FileText className="size-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuRadioGroup
                                                    value={
                                                        activeTranscript.source
                                                    }
                                                    onValueChange={
                                                        setActiveSource
                                                    }
                                                >
                                                    {transcriptList.map(
                                                        (candidate) => (
                                                            <DropdownMenuRadioItem
                                                                key={
                                                                    candidate.source
                                                                }
                                                                value={
                                                                    candidate.source
                                                                }
                                                            >
                                                                {candidate.source ===
                                                                "plaud"
                                                                    ? "Plaud"
                                                                    : candidate.source ===
                                                                        "mixed"
                                                                      ? i18n(
                                                                            "Mix",
                                                                        )
                                                                      : i18n(
                                                                            "Custom",
                                                                        )}
                                                            </DropdownMenuRadioItem>
                                                        ),
                                                    )}
                                                </DropdownMenuRadioGroup>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </>
                            )}
                            {activeTranscript?.text && (
                                <MarkdownActions
                                    recordingId={recording.id}
                                    kind="transcript"
                                    collapseAtNarrowWidth
                                    source={activeTranscript.source}
                                    view={view}
                                />
                            )}
                            {!activeTranscript?.text &&
                                !knownTranscriptExists &&
                                !transcriptionRunning &&
                                !readOnly && (
                                    <>
                                        <Button
                                            onClick={() => startTranscription()}
                                            size="sm"
                                            disabled={
                                                transcriptionRunning ||
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
                                        {recording.isOwn !== false && (
                                            <TranscribeInBrowserButton
                                                recordingId={recording.id}
                                                disabled={
                                                    transcriptionRunning ||
                                                    recording.audioReaped
                                                }
                                                onComplete={
                                                    onTranscribeComplete ??
                                                    (() => {})
                                                }
                                            />
                                        )}
                                    </>
                                )}
                            {activeTranscript?.text && (
                                <button
                                    type="button"
                                    aria-expanded={transcriptOpen}
                                    aria-label={
                                        transcriptOpen
                                            ? i18n("Collapse transcript")
                                            : i18n("Expand transcript")
                                    }
                                    onClick={() => {
                                        if (widgets?.workflowVisible) {
                                            setWorkflowTranscriptExpanded(
                                                false,
                                            );
                                        } else {
                                            setTranscriptExpanded(
                                                !transcriptExpanded,
                                            );
                                        }
                                    }}
                                    className="flex min-h-8 items-center justify-center gap-1 rounded-sm text-sm font-medium transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-[560px]/transcription:size-8"
                                >
                                    {transcriptOpen ? (
                                        <ChevronUp className="size-4" />
                                    ) : (
                                        <ChevronDown className="size-4" />
                                    )}
                                    <span className="@max-[560px]/transcription:hidden">
                                        {transcriptOpen
                                            ? i18n("Collapse transcript")
                                            : i18n("Expand transcript")}
                                    </span>
                                </button>
                            )}
                        </div>
                    }
                >
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
                            nextSpeakerTurn={
                                playback && activeTranscript.turns?.length
                                    ? nextSpeakerTurn
                                    : undefined
                            }
                            shownVersion={activeTranscript.version}
                            onStale={onTranscriptStale}
                            onUnknownLabelsChange={handleUnknownLabelsChange}
                            readOnly={readOnly}
                        />
                    )}
                    {transcriptionRunning ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin size-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                            <p className="text-sm text-muted-foreground">
                                {i18n("Transcribing audio…")}
                            </p>
                        </div>
                    ) : activeTranscript?.text ? (
                        <div className="space-y-4">
                            <section
                                ref={transcriptSectionRef}
                                aria-label={i18n("Transcript content")}
                                className="relative max-h-96 overflow-y-auto rounded-lg bg-muted"
                            >
                                <TranscriptChapterBar
                                    key={`${attributionKey}:${activeTranscriptKey}`}
                                    widgetId={`recording-topics-${recording.id}`}
                                    topics={topics}
                                    expanded={transcriptOpen}
                                    scrollRef={transcriptSectionRef}
                                    canDetect={canDetectTopics}
                                    waitingForReview={heldForReview}
                                    detecting={detectingTopics}
                                    onDetect={() => void detectTopics()}
                                    onSelect={handleSelectTopic}
                                    hasCorrections={
                                        (shownCorrections?.list.length ?? 0) > 0
                                    }
                                    showOriginal={showOriginal}
                                    onShowOriginalChange={setShowOriginal}
                                />
                                <div className="p-4">
                                    <TranscriptView
                                        text={activeTranscript.text}
                                        source={activeTranscript.source}
                                        model={activeTranscript.model}
                                        storedTurns={activeTranscript.turns}
                                        speakerAttributions={
                                            speakerAttributions
                                        }
                                        scrollRef={transcriptSectionRef}
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
                                            shownCorrections && !showOriginal
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
                                            activeTranscript.source !== "mixed"
                                                ? learnMarks
                                                : null
                                        }
                                    />
                                </div>
                            </section>
                        </div>
                    ) : null}
                </WorkflowWidget>
            )}

            {canLearn &&
                activeTranscript &&
                (!widgets || widgets.learn.visible) && (
                    <SpeakerAccentContext value={accentPositions}>
                        <LearnReview
                            key={`${recording.id}:${view ?? "private"}:${activeTranscript.source}:${activeTranscriptKey}`}
                            recordingId={recording.id}
                            view={view}
                            source={
                                activeTranscript.source === "plaud"
                                    ? "plaud"
                                    : "riffado"
                            }
                            turns={activeTranscript.turns ?? []}
                            nextSpeakerTurn={
                                playback
                                    ? (label) => nextSpeakerTurn(label, true)
                                    : undefined
                            }
                            onFinished={handleReviewFinished}
                            onMarks={setLearnMarks}
                            frame={widgets?.learn.frame ?? "inline"}
                            widgetId={`recording-learn-review-${recording.id}`}
                            folderName={folderName}
                            showTrigger={false}
                            collapseReady
                        />
                    </SpeakerAccentContext>
                )}

            {activeTranscript?.text &&
                (!widgets || widgets.summary.visible) && (
                    <SummaryWidget
                        itemId={recording.id}
                        kind="audio"
                        canChange={!readOnly}
                        contentText={summaryTranscript?.text}
                        canSummarize={Boolean(
                            summaryTranscript ||
                                (orgView && transcriptList.length > 0),
                        )}
                        view={view}
                        source={summarySource}
                        canSwitchSource={canHavePlaudSummary}
                        onSourceChange={(source) =>
                            setSummarySelection({
                                recordingId: recording.id,
                                source,
                            })
                        }
                        sourceLabel={name}
                        speakerAttributions={summarySpeakerAttributions}
                        speakerLabels={summarySpeakerTags.map(
                            (speaker) => speaker.speaker,
                        )}
                        widget={widgets?.summary}
                        taskWidget={widgets?.taskReview}
                        workflowVisible={widgets?.workflowVisible ?? false}
                        profileName={processing?.profile?.name}
                        widgetId={`recording-summary-${recording.id}`}
                        taskWidgetId={`recording-task-review-${recording.id}`}
                        learnHold={learnSummaryHold}
                        refreshKey={followUpRevision}
                    />
                )}
        </div>
    );
}
