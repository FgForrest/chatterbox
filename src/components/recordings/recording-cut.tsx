"use client";

import { Loader2, Scissors, X } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useId,
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
import { Input } from "@/components/ui/input";
import { ActionTooltip } from "@/components/ui/tooltip";
import { getApiErrorMessage } from "@/lib/api-errors";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import {
    type CutRange,
    parseCutTime,
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
        <span className="inline-flex h-4 items-center gap-1 rounded-full border border-primary/40 bg-background px-2 text-xs leading-none text-primary">
            {edge === "start"
                ? i18n("Start {time}", { time })
                : i18n("End {time}", { time })}
            {set && (
                <button
                    type="button"
                    className="inline-flex h-full items-center rounded-full hover:bg-primary/10"
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

function CutTimeField({
    edge,
    invalid,
    hintId,
    onInvalidChange,
}: {
    edge: "start" | "end";
    invalid: boolean;
    hintId: string;
    onInvalidChange: (invalid: boolean) => void;
}) {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    const id = useId();
    const [draft, setDraft] = useState<string | null>(null);
    const value = edge === "start" ? cut?.range.startMs : cut?.range.endMs;
    const [committedValue, setCommittedValue] = useState(value);
    if (committedValue !== value) {
        setCommittedValue(value);
        setDraft(null);
    }
    if (!cut || value === undefined) return null;
    const commit = () => {
        if (draft === null) return;
        const parsed = parseCutTime(draft);
        const snapped =
            parsed === null
                ? null
                : snapCutEdge(
                      cut.activeTurns ?? [],
                      parsed,
                      edge,
                      cut.recording.duration,
                  );
        const valid =
            snapped !== null &&
            (edge === "start"
                ? snapped < cut.range.endMs
                : snapped > cut.range.startMs);
        onInvalidChange(!valid);
        setDraft(null);
        if (valid && snapped !== null) cut.setEdge(edge, snapped);
    };
    return (
        <label
            htmlFor={id}
            className="flex items-center gap-2 text-sm text-muted-foreground"
        >
            {edge === "start"
                ? i18n("From")
                : i18n({ id: "recording-cut-to", message: "To" })}
            <Input
                id={id}
                className="h-8 w-24 text-center font-mono text-sm text-foreground tabular-nums"
                value={draft ?? formatClock(value)}
                aria-invalid={invalid}
                aria-describedby={invalid ? hintId : undefined}
                onChange={(event) => {
                    setDraft(event.target.value);
                    onInvalidChange(false);
                }}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commit();
                    }
                }}
            />
        </label>
    );
}

export function RecordingCutPanel() {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    const hintId = useId();
    const [invalid, setInvalid] = useState({ start: false, end: false });
    const identity = `${cut?.open}:${cut?.recording.id}`;
    const [previousIdentity, setPreviousIdentity] = useState(identity);
    if (identity !== previousIdentity) {
        setPreviousIdentity(identity);
        setInvalid({ start: false, end: false });
    }
    if (!cut?.owner || (!cut.open && !cut.cutting)) return null;
    const { range, recording } = cut;
    const total = formatClock(recording.duration);
    const kept = formatClock(Math.max(0, range.endMs - range.startMs));
    const start = formatClock(range.startMs);
    const end = formatClock(recording.duration - range.endMs);
    let removed = "";
    if (range.startMs > 0 && range.endMs < recording.duration) {
        removed = i18n(
            "{start} will be removed from the start, {end} from the end.",
            { start, end },
        );
    } else if (range.startMs > 0) {
        removed = i18n("{start} will be removed from the start.", { start });
    } else if (range.endMs < recording.duration) {
        removed = i18n("{end} will be removed from the end.", { end });
    }
    return (
        <section
            className="space-y-3 rounded-lg border border-primary/40 bg-card p-4"
            aria-label={i18n("Cut recording")}
        >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                {cut.cutting ? (
                    <output className="inline-flex items-center gap-2 text-sm font-medium">
                        <Loader2 className="size-4 animate-spin text-primary" />
                        {i18n("Cutting {start}–{end}", {
                            start,
                            end: formatClock(range.endMs),
                        })}
                    </output>
                ) : (
                    <>
                        <span className="inline-flex items-center gap-2 text-sm font-medium">
                            <Scissors className="size-4 text-primary" />
                            {i18n("Cut recording")}
                        </span>
                        <div className="flex items-start gap-2">
                            <CutTimeField
                                edge="start"
                                invalid={invalid.start}
                                hintId={hintId}
                                onInvalidChange={(value) =>
                                    setInvalid((previous) => ({
                                        ...previous,
                                        start: value,
                                    }))
                                }
                            />
                            <span
                                aria-hidden="true"
                                className="pt-1 text-muted-foreground"
                            >
                                –
                            </span>
                            <CutTimeField
                                edge="end"
                                invalid={invalid.end}
                                hintId={hintId}
                                onInvalidChange={(value) =>
                                    setInvalid((previous) => ({
                                        ...previous,
                                        end: value,
                                    }))
                                }
                            />
                        </div>
                    </>
                )}
                <span className="text-sm">
                    {i18n("{kept} of {total} stays", { kept, total })}
                </span>
                {!cut.cutting && (
                    <span className="ml-auto inline-flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={cut.cancel}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            size="sm"
                            disabled={!validCutRange(range, recording.duration)}
                            onClick={cut.confirm}
                        >
                            {i18n("Cut…")}
                        </Button>
                    </span>
                )}
            </div>
            {!cut.cutting && (invalid.start || invalid.end) && (
                <p id={hintId} className="text-xs text-destructive">
                    {i18n(
                        "Enter mm:ss or h:mm:ss and keep the start before the end. The previous time was restored.",
                    )}
                </p>
            )}
            {cut.error && (
                <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                >
                    {cut.error}
                </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
                {cut.cutting ? (
                    recording.audioReaped ? (
                        i18n(
                            "The transcript is being cut on the server. You can leave. Learn, summary, title and topics will then run again.",
                        )
                    ) : (
                        i18n(
                            "Audio is cut on the server, about a minute for a half-hour recording. You can leave. Learn, summary, title and topics will then run again.",
                        )
                    )
                ) : (
                    <>
                        {removed && <>{removed} </>}
                        {i18n(
                            "You can also choose the start and end in the transcript: hover between paragraphs. A typed time snaps to the nearest sentence start.",
                        )}
                    </>
                )}
            </p>
        </section>
    );
}

export function CutParagraphBoundary({
    ms,
    startEdge = false,
    endEdge = false,
}: {
    ms: number;
    startEdge?: boolean;
    endEdge?: boolean;
}) {
    const cut = useRecordingCut();
    const i18n = useExtracted();
    if (!cut?.owner || !cut.open) return null;
    return (
        <div
            data-cut-boundary={ms}
            className="group/cut absolute inset-x-0 -top-4 z-20 h-4"
        >
            {(startEdge || endEdge) && (
                <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center gap-2">
                    <span className="pointer-events-none flex-1 border-t border-primary" />
                    <span className="pointer-events-auto inline-flex gap-1">
                        {startEdge && <CutEdgeChip edge="start" />}
                        {endEdge && <CutEdgeChip edge="end" />}
                    </span>
                    <span className="pointer-events-none flex-1 border-t border-primary" />
                </div>
            )}
            {!(startEdge || endEdge) && (
                <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center gap-2 opacity-0 transition-opacity group-hover/cut:opacity-100 group-focus-within/cut:opacity-100 motion-reduce:transition-none">
                    <span className="pointer-events-none flex-1 border-t border-dashed border-primary" />
                    <span className="pointer-events-none inline-flex h-4 shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-background px-2 text-xs leading-none shadow-sm group-hover/cut:pointer-events-auto group-focus-within/cut:pointer-events-auto">
                        <Scissors className="size-3 text-primary" />
                        <span className="font-mono tabular-nums text-muted-foreground">
                            {formatClock(ms)}
                        </span>
                        <button
                            type="button"
                            className="h-full rounded-full px-2 leading-none hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={ms >= cut.range.endMs}
                            onClick={() => cut.setEdge("start", ms)}
                        >
                            {i18n({
                                id: "recording-cut-start-here",
                                message: "Start here",
                            })}
                        </button>
                        <button
                            type="button"
                            className="h-full rounded-full px-2 leading-none hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={ms <= cut.range.startMs}
                            onClick={() => cut.setEdge("end", ms)}
                        >
                            {i18n("End here")}
                        </button>
                    </span>
                    <span className="pointer-events-none flex-1 border-t border-dashed border-primary" />
                </div>
            )}
        </div>
    );
}

export function CutPreviewOverlay() {
    const cut = useRecordingCut();
    if (!cut?.owner || (!cut.open && !cut.cutting)) return null;
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
