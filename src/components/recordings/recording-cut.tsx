"use client";

import { Loader2, Scissors, X } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { usePlayback } from "@/components/playback/playback-context";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ActionTooltip } from "@/components/ui/tooltip";
import { getApiErrorMessage } from "@/lib/api-errors";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import {
    type CutRange,
    snapCutEdge,
    validCutRange,
} from "@/lib/recordings/cut-range";
import { formatClock } from "@/lib/topics/timeline";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import type { Recording } from "@/types/recording";

interface CutState {
    recording: Recording;
    owner: boolean;
    open: boolean;
    cutting: boolean;
    error: string | null;
    disabledReason: string | null;
    range: CutRange;
    activeTurns: TranscriptTurn[] | null;
    toggle: () => void;
    cancel: () => void;
    setEdge: (edge: "start" | "end", ms: number) => void;
    reset: (edge: "start" | "end") => void;
    setBrowserTranscribing: (running: boolean) => void;
    setActiveTurns: (turns: TranscriptTurn[] | null) => void;
    confirm: () => void;
}
const CutContext = createContext<CutState | null>(null);

/** The single cut mode shared by the recording's player and transcript. */
export function useRecordingCut() {
    return useContext(CutContext);
}

export function RecordingCutProvider({
    recording,
    transcripts,
    transcribing,
    shared,
    onChanged,
    children,
}: {
    recording: Recording;
    transcripts: readonly {
        turns?: TranscriptTurn[] | null;
        version?: { transcriptionId: string; revision: number };
    }[];
    transcribing: boolean;
    shared: boolean;
    onChanged: () => void;
    children: ReactNode;
}) {
    const i18n = useExtracted();
    const playback = usePlayback();
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [cutting, setCutting] = useState(false);
    const [browserTranscribing, setBrowserTranscribing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const shownRevisions = useRef<
        { id: string; revision: number }[] | undefined
    >(undefined);
    const [range, setRange] = useState<CutRange>({
        startMs: 0,
        endMs: recording.duration,
    });
    const [activeTurns, setActiveTurns] = useState<TranscriptTurn[] | null>(
        transcripts[0]?.turns ?? null,
    );
    const identity = `${recording.id}:${recording.view ?? "private"}:${recording.cutAt ?? ""}`;
    const [currentIdentity, setCurrentIdentity] = useState(identity);
    const identityRef = useRef(identity);
    identityRef.current = identity;
    useEffect(() => {
        identityRef.current = identity;
        return () => {
            identityRef.current = "";
        };
    }, [identity]);
    const owner =
        recording.isOwn !== false &&
        recording.view !== "org" &&
        recording.view !== "received";
    const untimed = transcripts.some(
        (transcript) =>
            !transcript.turns?.length ||
            transcript.turns.some((turn) => turn.endMs <= turn.startMs),
    );
    const disabledReason = cutting
        ? i18n("Cutting…")
        : transcribing || browserTranscribing
          ? i18n("Wait for transcription to finish before cutting.")
          : untimed
            ? i18n("This transcript has no turn times, so it cannot be cut.")
            : null;
    const changedRef = useRef(onChanged);
    changedRef.current = onChanged;
    const discoveryVersion = useRef(0);
    const watchedJobs = useRef(new Set<string>());
    const cutError = useCallback(
        (message: string) => {
            switch (message) {
                case "Invalid cut range":
                    return i18n(
                        "Choose a valid range that keeps part of the recording.",
                    );
                case "Unauthorized":
                case "Authentication required":
                    return i18n("Sign in again before cutting the recording.");
                case "The cut job is no longer running":
                    return i18n("Cutting was interrupted. Try again.");
                case "Your access to this application has been withdrawn":
                    return i18n(
                        "Your access to this application has been withdrawn.",
                    );
                case "Your access could not be verified right now. Try again shortly.":
                    return i18n(
                        "Your access could not be verified right now. Try again shortly.",
                    );
                case "Account suspended":
                    return i18n(
                        "Your account is suspended. Contact an administrator.",
                    );
                case "Processing was interrupted":
                    return i18n("Cutting was interrupted. Try again.");
                case "Only the recording owner may cut it":
                    return i18n("Only the recording's owner can cut it.");
                case "Recording not found":
                    return i18n("This recording no longer exists.");
                case "There is no audio or transcript to cut":
                    return i18n(
                        "There is nothing left to cut: the recording has no audio or transcript.",
                    );
                case "Choose a smaller range that keeps part of the recording":
                    return i18n(
                        "Choose a smaller range that keeps part of the recording.",
                    );
                case "The range must keep at least one turn of every transcript":
                    return i18n("Keep at least one turn of every transcript.");
                case "This transcript has no turn times":
                    return i18n(
                        "This transcript has no turn times, so it cannot be cut.",
                    );
                case "Transcription or cutting is already running for this recording":
                case "Cutting is already running for this recording":
                    return i18n("Wait for transcription or cutting to finish.");
                case "The recording or transcript changed. Reload it and choose the cut again.":
                    return i18n(
                        "The recording or transcript changed. Reload it and choose the cut again.",
                    );
                default:
                    return i18n("The recording could not be cut. Try again.");
            }
        },
        [i18n],
    );
    const showFailure = useCallback(
        (message: string, failedIdentity: string) => {
            if (identityRef.current !== failedIdentity) {
                toast.error(message);
                return;
            }
            setError(message);
            setCutting(false);
            setOpen(true);
        },
        [],
    );
    const refresh = useCallback(() => {
        invalidateItemProcessing(recording.id);
        changedRef.current();
    }, [recording.id]);
    const watchCut = useCallback(
        (id: string, watchedIdentity: string) => {
            if (watchedJobs.current.has(id)) return;
            watchedJobs.current.add(id);
            let stopped = false;
            let errors = 0;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const controller = new AbortController();
            const finish = (message?: string) => {
                if (stopped) return;
                stopped = true;
                watchedJobs.current.delete(id);
                clearTimeout(timer);
                clearTimeout(deadline);
                controller.abort();
                if (message) showFailure(message, watchedIdentity);
                else if (identityRef.current === watchedIdentity) {
                    setCutting(false);
                    refresh();
                }
            };
            const deadline = setTimeout(
                () => finish(cutError("")),
                65 * 60 * 1000,
            );
            const poll = async () => {
                try {
                    const response = await fetch(`/api/jobs/${id}`, {
                        signal: controller.signal,
                    });
                    if (!response.ok)
                        throw new Error(await getApiErrorMessage(response, ""));
                    const job = (await response.json()) as {
                        status: string;
                        error?: string;
                    };
                    if (stopped) return;
                    if (job.status === "failed") {
                        finish(cutError(job.error ?? ""));
                        return;
                    }
                    if (job.status === "completed") {
                        finish();
                        return;
                    }
                    if (job.status !== "pending" && job.status !== "processing")
                        throw new Error("status");
                    errors = 0;
                } catch (error) {
                    if (stopped) return;
                    if (++errors >= 3) {
                        finish(
                            cutError(
                                error instanceof Error ? error.message : "",
                            ),
                        );
                        return;
                    }
                }
                if (!stopped) timer = setTimeout(() => void poll(), 2000);
            };
            void poll();
        },
        [cutError, refresh, showFailure],
    );
    const watchCutRef = useRef(watchCut);
    watchCutRef.current = watchCut;
    useEffect(() => {
        if (!owner) return;
        let cancelled = false;
        const version = discoveryVersion.current;
        void (async () => {
            try {
                const response = await fetch(
                    `/api/recordings/${recording.id}/cut`,
                );
                if (!response.ok) return;
                const { job } = (await response.json()) as {
                    job?: {
                        id?: string;
                        status: string;
                        range?: CutRange | null;
                    } | null;
                };
                if (cancelled || version !== discoveryVersion.current) return;
                if (
                    job?.id &&
                    (job.status === "pending" || job.status === "processing")
                ) {
                    setCutting(true);
                    setOpen(false);
                    if (job.range) setRange(job.range);
                    watchCutRef.current(job.id, identity);
                }
            } catch {}
        })();
        return () => {
            cancelled = true;
        };
    }, [identity, recording.id, owner]);
    useEffect(() => {
        if (disabledReason && !cutting && !error) setOpen(false);
    }, [disabledReason, cutting, error]);
    const setEdge = useCallback(
        (edge: "start" | "end", ms: number) => {
            const snapped = Math.max(
                0,
                Math.min(recording.duration, Math.round(ms)),
            );
            setRange((previous) => ({
                ...previous,
                [edge === "start" ? "startMs" : "endMs"]: snapped,
            }));
        },
        [recording.duration],
    );
    const cancel = () => {
        setOpen(false);
        setError(null);
        setRange({ startMs: 0, endMs: recording.duration });
    };
    const execute = async () => {
        const submittedIdentity = identity;
        discoveryVersion.current++;
        setError(null);
        setConfirming(false);
        setOpen(false);
        setCutting(true);
        playback?.pause();
        try {
            const response = await fetch(
                `/api/recordings/${recording.id}/cut`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...range,
                        ...(shownRevisions.current
                            ? { revisions: shownRevisions.current }
                            : {}),
                    }),
                },
            );
            if (!response.ok)
                throw new Error(await getApiErrorMessage(response, ""));
            const result = (await response.json()) as { jobId: string };
            watchCut(result.jobId, submittedIdentity);
        } catch (error) {
            showFailure(
                cutError(error instanceof Error ? error.message : ""),
                submittedIdentity,
            );
        }
    };
    if (currentIdentity !== identity) {
        setCurrentIdentity(identity);
        setError(null);
        setOpen(false);
        setCutting(false);
        setBrowserTranscribing(false);
        setConfirming(false);
        setRange({ startMs: 0, endMs: recording.duration });
        setActiveTurns(transcripts[0]?.turns ?? null);
        shownRevisions.current = undefined;
    }
    const state: CutState = {
        recording,
        owner,
        open,
        cutting,
        error,
        disabledReason,
        range,
        activeTurns,
        toggle: () => {
            if (owner && !disabledReason) {
                if (open) cancel();
                else {
                    setError(null);
                    setRange({ startMs: 0, endMs: recording.duration });
                    shownRevisions.current = transcripts.every(
                        (transcript) => transcript.version,
                    )
                        ? transcripts.map((transcript) => ({
                              id: transcript.version?.transcriptionId ?? "",
                              revision: transcript.version?.revision ?? 0,
                          }))
                        : undefined;
                    setOpen(true);
                }
            }
        },
        cancel,
        setEdge,
        reset: (edge) =>
            setEdge(edge, edge === "start" ? 0 : recording.duration),
        setActiveTurns,
        setBrowserTranscribing,
        confirm: () => setConfirming(true),
    };
    const start = formatClock(range.startMs);
    const end = formatClock(recording.duration - range.endMs);
    const kept = formatClock(range.endMs - range.startMs);
    const audio = !recording.audioReaped;
    const description = audio
        ? range.startMs > 0 && range.endMs < recording.duration
            ? i18n(
                  "{start} at the start and {end} at the end are deleted from the audio and the transcript. The recording will then be {kept} long.",
                  { start, end, kept },
              )
            : range.startMs > 0
              ? i18n(
                    "{start} at the start is deleted from the audio and the transcript. The recording will then be {kept} long.",
                    { start, kept },
                )
              : i18n(
                    "{end} at the end is deleted from the audio and the transcript. The recording will then be {kept} long.",
                    { end, kept },
                )
        : range.startMs > 0 && range.endMs < recording.duration
          ? i18n(
                "{start} at the start and {end} at the end are deleted from the transcript. The recording will then be {kept} long.",
                { start, end, kept },
            )
          : range.startMs > 0
            ? i18n(
                  "{start} at the start is deleted from the transcript. The recording will then be {kept} long.",
                  { start, kept },
              )
            : i18n(
                  "{end} at the end is deleted from the transcript. The recording will then be {kept} long.",
                  { end, kept },
              );
    return (
        <CutContext value={state}>
            {children}
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {i18n("Delete the cut parts?")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {description}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <ul className="list-disc space-y-2 pl-5 text-sm">
                        <li>{i18n("This cannot be undone.")}</li>
                        <li>
                            {i18n(
                                "The summary, title, topics and tasks are generated again and Learn runs again. What was confirmed in the Almanac stays.",
                            )}
                        </li>
                        <li>
                            {recording.deviceSn !== "local"
                                ? i18n(
                                      "The original recording stays in the Plaud app and in exports and backups made before.",
                                  )
                                : i18n(
                                      "Exports and backups made before keep the original.",
                                  )}
                        </li>
                    </ul>
                    {shared && (
                        <p className="text-sm font-medium">
                            {i18n(
                                "This recording is shared with the Organization. Colleagues will see the cut version, and its summary in the Organization is generated again.",
                            )}
                        </p>
                    )}
                    <AlertDialogFooter>
                        <AlertDialogCancel>{i18n("Cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={!validCutRange(range, recording.duration)}
                            onClick={() => void execute()}
                        >
                            {i18n("Delete and cut")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </CutContext>
    );
}

export function RecordingCutButton() {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    if (!cut?.owner) return null;
    const label =
        cut.disabledReason ??
        (cut.open ? i18n("Close cutting") : i18n("Cut the start and end"));
    return (
        <ActionTooltip label={label}>
            <span className="inline-flex">
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={label}
                    aria-pressed={cut.open}
                    className={
                        cut.open
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground"
                    }
                    disabled={cut.disabledReason !== null}
                    onClick={cut.toggle}
                >
                    {cut.cutting ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Scissors className="size-4" />
                    )}
                </Button>
            </span>
        </ActionTooltip>
    );
}

export function CutEdgeChip({ edge }: { edge: "start" | "end" }) {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    if (!cut) return null;
    const time = formatClock(
        edge === "start" ? cut.range.startMs : cut.range.endMs,
    );
    const set =
        edge === "start"
            ? cut.range.startMs > 0
            : cut.range.endMs < cut.recording.duration;
    return (
        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-background px-2 py-1 text-xs text-primary">
            {edge === "start"
                ? i18n("Start {time}", { time })
                : i18n("End {time}", { time })}
            {set && (
                <button
                    type="button"
                    className="rounded-full p-0.5 hover:bg-primary/10"
                    onClick={() => cut.reset(edge)}
                    aria-label={
                        edge === "start"
                            ? i18n("Reset start")
                            : i18n("Reset end")
                    }
                >
                    <X className="size-3" />
                </button>
            )}
        </span>
    );
}

export function RecordingCutBar() {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    const playback = usePlayback();
    const [position, setPosition] = useState(0);
    useEffect(
        () => playback?.subscribe((state) => setPosition(Math.round(state.ms))),
        [playback],
    );
    if (cut?.cutting)
        return (
            <output className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {i18n("Cutting…")}
            </output>
        );
    if (!cut?.open) return null;
    const { range, recording } = cut;
    const changed = range.startMs > 0 || range.endMs < recording.duration;
    const total = formatClock(recording.duration);
    const kept = formatClock(Math.max(0, range.endMs - range.startMs));
    return (
        <section
            className="sticky top-0 z-30 space-y-2 rounded-lg border border-primary/40 bg-background p-3 shadow-sm"
            aria-label={i18n("Cut recording")}
        >
            <div className="flex flex-wrap items-center gap-2">
                <span className="mr-2 inline-flex items-center gap-2 text-sm font-medium">
                    <Scissors className="size-4 text-primary" />
                    {i18n("Cut recording")}
                </span>
                <CutEdgeChip edge="start" />
                <CutEdgeChip edge="end" />
                {!recording.audioReaped && (
                    <>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                cut.setEdge(
                                    "start",
                                    snapCutEdge(
                                        cut.activeTurns ?? [],
                                        position,
                                        "start",
                                    ),
                                )
                            }
                        >
                            {i18n({
                                id: "recording-cut-start-here",
                                message: "Start here",
                            })}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                cut.setEdge(
                                    "end",
                                    snapCutEdge(
                                        cut.activeTurns ?? [],
                                        position,
                                        "end",
                                    ),
                                )
                            }
                        >
                            {i18n("End here")}
                        </Button>
                        <span
                            className="font-mono text-xs tabular-nums"
                            title={i18n("From the playback position")}
                        >
                            {formatClock(position)}
                        </span>
                    </>
                )}
                <span className="ml-auto inline-flex gap-2">
                    <Button variant="outline" size="sm" onClick={cut.cancel}>
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        size="sm"
                        disabled={
                            !changed ||
                            !validCutRange(range, recording.duration)
                        }
                        onClick={cut.confirm}
                    >
                        {i18n("Cut…")}
                    </Button>
                </span>
            </div>
            {cut.error && (
                <p role="alert" className="text-sm text-destructive">
                    {cut.error}
                </p>
            )}
            <p className="text-sm font-medium">
                {changed
                    ? i18n("{kept} of {total} stays", { kept, total })
                    : i18n("The whole recording for now, {total}", { total })}
            </p>
            <p className="text-xs text-muted-foreground">
                {!changed
                    ? i18n(
                          "Hover the turn where the recording should start and click Start here. On the last turn to keep, click End here.",
                      )
                    : recording.audioReaped
                      ? i18n(
                            "The cut turns are deleted from the transcript and cannot be restored. The summary, title, topics and tasks are then generated again.",
                        )
                      : i18n(
                            "The cut part is deleted from the audio and the transcript and cannot be restored. The summary, title, topics and tasks are then generated again.",
                        )}
            </p>
        </section>
    );
}

export function CutTurnAction({
    turn,
    edge,
}: {
    turn: TranscriptTurn;
    edge: "start" | "end";
}) {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    if (!cut?.open) return null;
    return (
        <button
            type="button"
            className="relative z-10 inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs opacity-0 transition-opacity group-hover/para:opacity-100 group-focus-within/para:opacity-100 focus:opacity-100"
            onClick={() =>
                cut.setEdge(edge, edge === "start" ? turn.startMs : turn.endMs)
            }
        >
            <Scissors className="size-3 text-primary" />
            {edge === "start"
                ? i18n({
                      id: "recording-cut-start-here",
                      message: "Start here",
                  })
                : i18n("End here")}
        </button>
    );
}

export function CutLine({ edge }: { edge: "start" | "end" }) {
    return (
        <div className="flex items-center gap-2 py-1">
            <span className="flex-1 border-t border-dashed border-primary" />
            <CutEdgeChip edge={edge} />
            <span className="flex-1 border-t border-dashed border-primary" />
        </div>
    );
}

export function CutPreviewOverlay() {
    const cut = useRecordingCut();
    if (!cut?.open) return null;
    const hatch = {
        backgroundImage:
            "repeating-linear-gradient(135deg, transparent, transparent 3px, var(--muted-foreground) 3px, var(--muted-foreground) 4px)",
    };
    return (
        <div
            className="pointer-events-none absolute inset-0 overflow-hidden rounded"
            aria-hidden="true"
        >
            <div
                className="absolute inset-y-0 left-0 bg-muted/70 opacity-50"
                style={{
                    ...hatch,
                    width: `${(cut.range.startMs / cut.recording.duration) * 100}%`,
                }}
            />
            <div
                className="absolute inset-y-0 right-0 bg-muted/70 opacity-50"
                style={{
                    ...hatch,
                    width: `${((cut.recording.duration - cut.range.endMs) / cut.recording.duration) * 100}%`,
                }}
            />
        </div>
    );
}
