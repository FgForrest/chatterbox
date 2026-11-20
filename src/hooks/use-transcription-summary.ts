"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgendaPresence } from "@/components/meetings/recording-agenda-context";
import { useItemPartFetch } from "@/hooks/use-item-part-fetch";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ProfileChannel } from "@/lib/profiles/settings";
import {
    addSummarizingId,
    bumpContentGeneration,
    contentGenerationFor,
    isSummarizingForView,
    rememberTranscriptionText,
    removeSummarizingId,
    shouldApplyFetchedSummary,
    shouldApplySummaryToView,
} from "@/lib/summary/job-scope";
import type {
    SettingsProfileSummary,
    SettingsProfilesPage,
} from "@/types/settings";

export type SummarySource = "plaud" | "riffado";

import {
    followJob,
    type JobProgressSnapshot,
    type JobSnapshot,
} from "@/lib/jobs/client";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";
import {
    createStreamEventParser,
    type SummaryStatusProgress,
} from "@/lib/summary/progress-stream";

/**
 * A job's stored progress, narrowed to what the status line can render.
 *
 * The job row's `progress` is deliberately loose -- it is shared by every job
 * kind -- so anything that does not look like multi-pass progress is dropped
 * rather than rendered as `NaN/NaN`.
 */
function toSummaryProgress(
    raw: JobProgressSnapshot | null | undefined,
): SummaryStatusProgress | null {
    if (!raw) return null;
    if (raw.phase !== "passes" && raw.phase !== "merging") return null;
    const completed = Number(raw.completed);
    const total = Number(raw.total);
    if (!Number.isFinite(completed) || !Number.isFinite(total)) return null;
    return { phase: raw.phase, completed, total };
}

export interface SummaryVersion {
    summaryId: string;
    revision: number;
}

export interface SummaryData {
    summaryId?: string;
    speakerNumberOffset?: number | null;
    editedAt?: string | null;
    editedByName?: string | null;
    revision?: number;
    correctedWithRemarks?: boolean;
    remarksAppliedCount?: number;
    canEditSummary?: boolean;
    hasAgenda?: boolean;
    agendaCandidateCount?: number;
    summary: string | null;
    keyPoints: string[] | null;
    actionItems: string[] | null;
    source: SummarySource;
    itemProfileId?: string | null;
    profileName?: string | null;
    profileId?: string | null;
    /** On GET, distinguishes missing provenance from denied profile access. */
    profileVisibility?: "readable" | "unresolved" | "hidden";
    transcriptionId?: string | null;
    availableSources?: SummarySource[];
    provider?: string;
    model?: string;
    /**
     * Multi-pass provenance, absent for a single-pass summary. Returned by
     * both POST and GET, so the badge survives a reload.
     */
    multiPass?: {
        roundsRequested: number;
        passesUsed: number;
        merged: boolean;
    };
    /**
     * On GET: made from the transcript before its corrections changed, so
     * names or terms in it may be stale.
     */
    stale?: boolean;
    /** The summary was made from a different content row or revision. */
    olderContent?: boolean;
    /** The item's effective folder scope differs from the summary run. */
    scopeChanged?: boolean;
    /**
     * Present on GET when a summary job for this recording is queued or
     * running -- started in another tab, by an automatic run after a sync, or
     * picked back up by a worker after a restart. Lets a freshly opened page
     * show that work is in progress instead of an empty panel.
     */
    activeJob?: {
        jobId: string;
        status: "pending" | "processing" | "completed" | "failed";
        progress: JobProgressSnapshot | null;
        kind?: string;
    };
    /** Prompt id actually used server-side. Only present on POST responses. */
    promptId?: string;
    /**
     * True when the requested prompt id couldn't be resolved (e.g. a
     * custom prompt deleted from another tab) and the server fell back
     * to the default prompt instead. Only present on POST responses.
     */
    promptFallback?: boolean;
}

interface UseTranscriptionSummaryOptions {
    /** Recording id used for `/api/recordings/:id/summary` requests. */
    recordingId: string | null | undefined;
    summarySource?: SummarySource;
    /**
     * Latest transcription text. A change triggers a read for the new revision.
     */
    transcriptionText: string | null | undefined;
    /** `org` reads and writes the Organization view of a shared recording. */
    view?: RecordingView;
    version?: string;
    transcriptPending?: boolean;
    /** Profile channel of the item being summarized. */
    profileChannel?: ProfileChannel;
}

/**
 * Shared summary state for recording and mail views.
 */
export function useTranscriptionSummary({
    recordingId,
    summarySource = "riffado",
    transcriptionText,
    view,
    version,
    transcriptPending,
    profileChannel = "audio",
}: UseTranscriptionSummaryOptions) {
    const summaryUrl = useCallback(
        (targetId: string, query = "") =>
            withRecordingView(
                `/api/recordings/${targetId}/summary${query}`,
                view,
            ),
        [view],
    );
    const [presenceById, setPresenceById] = useState<
        Record<string, AgendaPresence>
    >({});
    const rememberPresence = useCallback((id: string, data: SummaryData) => {
        if (
            typeof data.hasAgenda !== "boolean" ||
            typeof data.agendaCandidateCount !== "number"
        )
            return;
        setPresenceById((value) => ({
            ...value,
            [id]: {
                hasAgenda: data.hasAgenda ?? false,
                agendaCandidateCount: data.agendaCandidateCount ?? 0,
            },
        }));
    }, []);
    const [availableSummarySources, setAvailableSummarySources] = useState<
        SummarySource[]
    >([]);
    const [summarizingIds, setSummarizingIds] = useState(
        () => new Set<string>(),
    );
    const summarizingIdsRef = useRef(summarizingIds);
    const isSummarizing = isSummarizingForView(recordingId, summarizingIds);
    // Multi-pass progress for the recording currently generating, and the
    // clock beside it. Both are cleared when generation ends.
    //
    // The clock exists for the single-pass path too, which reports no
    // progress at all: a spinner that never changes is indistinguishable
    // from a hung request, which is how a slow run was first reported.
    const [summaryProgress, setSummaryProgress] =
        useState<SummaryStatusProgress | null>(null);
    const [summaryElapsedMs, setSummaryElapsedMs] = useState(0);
    const [summaryExpanded, setSummaryExpanded] = useState(true);
    const [summaryProfileId, setSummaryProfileIdState] = useState("");
    const [summaryProfileOptions, setSummaryProfileOptions] = useState<
        SettingsProfileSummary[]
    >([]);
    const [itemProfileId, setItemProfileId] = useState<string | null>(null);
    const [summaryProfilesLoading, setSummaryProfilesLoading] = useState(true);
    const userSelectedProfileRef = useRef(false);
    const setSummaryProfileId = useCallback(
        (profileId: string) => {
            userSelectedProfileRef.current = true;
            setSummaryProfileIdState(profileId);
            if (!itemProfileId) return;
            const key = `summary-profile:${profileChannel}:${itemProfileId}`;
            try {
                if (profileId === itemProfileId) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, profileId);
                }
            } catch {}
        },
        [itemProfileId, profileChannel],
    );

    const [summaryFetchKey, setSummaryFetchKey] = useState(0);
    const summaryIdentity = `${recordingId}:summary:${summarySource}`;
    const contentView = view ?? "private";
    const readUrl = recordingId
        ? summaryUrl(recordingId, `?source=${summarySource}`)
        : null;
    const summaryCache = useRef(new Map<string, SummaryData | null>());
    const {
        data: readSummary,
        status: summaryStatus,
        lastOk: summaryLoaded,
        getData: getDisplayedSummary,
        cancel: cancelSummaryRead,
        reading: summaryReadPending,
        reload: reloadSummary,
        setData: setReadSummary,
    } = useItemPartFetch<SummaryData>(readUrl, version, summaryIdentity, {
        cachedData: readUrl ? summaryCache.current.get(readUrl) : undefined,
        onLoad: handleSummaryRead,
        paused: transcriptPending,
        refreshKey: summaryFetchKey,
    });
    const setSummary = useCallback(
        (
            data: SummaryData | null,
            options?: Parameters<typeof setReadSummary>[1],
        ) => {
            if (setReadSummary(data, options) && readUrl) {
                summaryCache.current.set(readUrl, data);
            }
        },
        [readUrl, setReadSummary],
    );
    const summaryData = readSummary?.summary ? readSummary : null;

    useEffect(() => {
        const controller = new AbortController();
        userSelectedProfileRef.current = false;
        setSummaryProfileIdState("");
        setSummaryProfilesLoading(true);
        fetch(
            `/api/settings/profiles?channel=${encodeURIComponent(profileChannel)}&pageSize=100`,
            { signal: controller.signal },
        )
            .then((res) => (res.ok ? res.json() : null))
            .then((data: SettingsProfilesPage | null) => {
                if (!data) return;
                setSummaryProfileOptions(
                    view === "org"
                        ? data.profiles.filter(
                              (profile) => profile.scope === "organization",
                          )
                        : data.profiles,
                );
            })
            .catch(() => {})
            .finally(() => {
                if (!controller.signal.aborted) {
                    setSummaryProfilesLoading(false);
                }
            });
        return () => controller.abort();
    }, [profileChannel, view]);

    useEffect(() => {
        if (
            userSelectedProfileRef.current ||
            summaryProfileOptions.length === 0
        ) {
            return;
        }
        let remembered: string | null = null;
        if (itemProfileId) {
            try {
                remembered = localStorage.getItem(
                    `summary-profile:${profileChannel}:${itemProfileId}`,
                );
            } catch {}
        }
        const resolvedScope = view === "org" ? "organization" : "personal";
        const selected =
            summaryProfileOptions.find(
                (profile) => profile.id === remembered,
            ) ??
            summaryProfileOptions.find(
                (profile) => profile.id === itemProfileId,
            ) ??
            summaryProfileOptions.find((profile) => profile.isYourDefault) ??
            summaryProfileOptions.find(
                (profile) =>
                    profile.scope === resolvedScope && profile.isDefault,
            ) ??
            summaryProfileOptions.find((profile) => profile.isDefault) ??
            summaryProfileOptions[0];
        setSummaryProfileIdState(selected?.id ?? "");
    }, [itemProfileId, profileChannel, summaryProfileOptions, view]);

    const recordingIdRef = useRef(recordingId);
    const summarySourceRef = useRef(summarySource);
    const viewRef = useRef(contentView);
    viewRef.current = contentView;
    const contentGenByIdRef = useRef(new Map<string, number>());
    const lastTextByIdRef = useRef(
        new Map<string, string | null | undefined>(),
    );
    const summaryStartedAtRef = useRef<number | null>(null);
    // Stops job polling when the hook goes away. Without it, a component
    // unmounted while a summary is running would keep requesting the job
    // until it settled -- for minutes, on a page nobody is looking at.
    const followAbortRef = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        followAbortRef.current = controller;
        return () => controller.abort();
    }, []);
    recordingIdRef.current = recordingId;
    summarySourceRef.current = summarySource;

    const previousRecordingId = useRef(recordingId);
    const transcriptionTextBySource = useRef(
        new Map<string, string | null | undefined>(),
    );

    useEffect(() => {
        const recordingChanged = previousRecordingId.current !== recordingId;
        previousRecordingId.current = recordingId;
        if (recordingChanged) {
            summaryCache.current.clear();
            setAvailableSummarySources([]);
            setItemProfileId(null);
            userSelectedProfileRef.current = false;
        }
        if (!recordingId) return;
        const texts = transcriptionTextBySource.current;
        const changed =
            texts.has(summaryIdentity) &&
            texts.get(summaryIdentity) !== transcriptionText;
        texts.set(summaryIdentity, transcriptionText);

        if (summarySource === "riffado") {
            const changed = rememberTranscriptionText(
                lastTextByIdRef.current,
                recordingId,
                transcriptionText,
            );
            if (changed) {
                bumpContentGeneration(contentGenByIdRef.current, recordingId);
            }
        }

        if (changed && !recordingChanged) {
            setSummaryFetchKey((key) => key + 1);
        }
    }, [recordingId, summarySource, summaryIdentity, transcriptionText]);

    /**
     * Adopt a summary job that is already running.
     *
     * The job may have been started by another tab, by an automatic run after
     * a sync, or by this very page before a deploy replaced the container
     * underneath it. In all three cases the alternative is an idle-looking
     * panel while work the user is waiting for happens invisibly.
     */
    const attachToActiveJob = useCallback(
        async (
            targetId: string,
            job: NonNullable<SummaryData["activeJob"]>,
        ) => {
            if (summarizingIdsRef.current.has(targetId)) return;
            const generation = contentGenerationFor(
                contentGenByIdRef.current,
                targetId,
            );
            const isCurrent = () =>
                viewRef.current === contentView &&
                summarySourceRef.current === "riffado" &&
                shouldApplyFetchedSummary(
                    recordingIdRef.current,
                    targetId,
                    contentGenerationFor(contentGenByIdRef.current, targetId),
                    generation,
                );

            summarizingIdsRef.current = addSummarizingId(
                summarizingIdsRef.current,
                targetId,
            );
            setSummarizingIds(summarizingIdsRef.current);
            setSummaryProgress(toSummaryProgress(job.progress));
            setSummaryElapsedMs(0);
            // The clock starts now rather than when the job did. Showing a
            // duration this page did not witness would be a guess: the job
            // row records when it was created, not how long the user has been
            // waiting, and those differ by however long it sat in the queue.
            summaryStartedAtRef.current = Date.now();

            invalidateItemProcessing(targetId);
            try {
                let current = job;
                while (isCurrent()) {
                    setSummaryProgress(toSummaryProgress(current.progress));
                    const snapshot: JobSnapshot | null = await followJob(
                        current.jobId,
                        {
                            signal: followAbortRef.current?.signal,
                            onProgress: (raw) => {
                                if (!isCurrent()) return;
                                const narrowed = toSummaryProgress(raw);
                                if (narrowed) setSummaryProgress(narrowed);
                            },
                        },
                    );
                    if (!snapshot || !isCurrent()) return;
                    if (snapshot.status !== "completed") {
                        if (
                            current.kind !== "pipeline.advance" &&
                            isCurrent()
                        ) {
                            toast.error(
                                snapshot.error || "Summary generation failed",
                            );
                        }
                        return;
                    }
                    const data = await reloadSummary();
                    if (!isCurrent()) return;
                    if (data?.summary) {
                        toast.success("Summary generated");
                        return;
                    }
                    const next = data?.activeJob;
                    if (
                        !next ||
                        next.jobId === current.jobId ||
                        (next.status !== "pending" &&
                            next.status !== "processing")
                    ) {
                        return;
                    }
                    current = next;
                }
            } catch {
                // Nothing to report: this client only ever observed the job,
                // and an observation that fails says nothing about the work.
            } finally {
                invalidateItemProcessing(targetId);
                summarizingIdsRef.current = removeSummarizingId(
                    summarizingIdsRef.current,
                    targetId,
                );
                setSummarizingIds(summarizingIdsRef.current);
                summaryStartedAtRef.current = null;
                setSummaryProgress(null);
                setSummaryElapsedMs(0);
            }
        },
        [contentView, reloadSummary],
    );

    function handleSummaryRead(data: SummaryData, signal: AbortSignal) {
        if (!recordingId || !readUrl) return;
        summaryCache.current.set(readUrl, data);
        rememberPresence(recordingId, data);
        setItemProfileId(data.itemProfileId ?? null);
        setAvailableSummarySources(data.availableSources ?? []);
        for (const source of data.availableSources ?? []) {
            if (source === summarySource) continue;
            const url = summaryUrl(recordingId, `?source=${source}`);
            void fetch(url, { signal })
                .then(async (response) => {
                    if (!response.ok) return;
                    const prefetched = (await response.json()) as SummaryData;
                    if (!signal.aborted && prefetched.summary) {
                        summaryCache.current.set(url, prefetched);
                    }
                })
                .catch(() => {});
        }
        const active = data.activeJob;
        if (active?.status === "pending" || active?.status === "processing") {
            void attachToActiveJob(recordingId, active);
        }
    }

    const handleSummarize = useCallback(
        async (
            selectedProfileId?: string,
            correction?: {
                reviseWithRemarks?: boolean;
                replaceEdited?: boolean;
                revision?: number;
                summaryId?: string;
                onSuccess?: () => void;
            },
        ) => {
            if (!recordingId) return;
            if (summarySource !== "riffado") return;
            if (summarizingIdsRef.current.has(recordingId)) return;
            const targetId = recordingId;
            const postGeneration = contentGenerationFor(
                contentGenByIdRef.current,
                targetId,
            );
            const postIsCurrent = () =>
                viewRef.current === contentView &&
                summarySourceRef.current === "riffado" &&
                shouldApplyFetchedSummary(
                    recordingIdRef.current,
                    targetId,
                    contentGenerationFor(contentGenByIdRef.current, targetId),
                    postGeneration,
                );
            cancelSummaryRead();
            summarizingIdsRef.current = addSummarizingId(
                summarizingIdsRef.current,
                targetId,
            );
            setSummarizingIds(summarizingIdsRef.current);
            setSummaryProgress(null);
            setSummaryElapsedMs(0);
            summaryStartedAtRef.current = Date.now();

            const summaryAtStart = getDisplayedSummary();
            const notifySuccess = () => {
                if (correction?.onSuccess) correction.onSuccess();
                else toast.success("Summary generated");
            };
            const applyResult = (data: SummaryData) => {
                if (!postIsCurrent()) return;
                const latest = getDisplayedSummary();
                const latestRevision = latest?.revision;
                const resultRevision = data.revision;
                const comparable =
                    latest?.summaryId !== undefined &&
                    latest.summaryId === data.summaryId &&
                    latestRevision !== undefined &&
                    resultRevision !== undefined;
                if (
                    !comparable &&
                    latest !== undefined &&
                    latest !== summaryAtStart
                ) {
                    void reloadSummary();
                } else if (!comparable || latestRevision < resultRevision) {
                    const readPending = summaryReadPending();
                    rememberPresence(targetId, data);
                    setSummary(data);
                    setAvailableSummarySources((current) =>
                        current.includes("riffado")
                            ? current
                            : [...current, "riffado"],
                    );
                    if (readPending) void reloadSummary();
                }
                notifySuccess();
            };

            /**
             * Follow a job whose stream this client lost, and report how it ended.
             *
             * Returns false only when the outcome is genuinely unknown -- the job
             * could not be found, or following was abandoned -- so the caller can
             * fall back to saying so rather than inventing a verdict.
             */
            const followSummaryJob = async (
                jobId: string,
            ): Promise<boolean> => {
                const snapshot = await followJob(jobId, {
                    signal: followAbortRef.current?.signal,
                    onProgress: (raw) => {
                        if (!postIsCurrent()) return;
                        const narrowed = toSummaryProgress(raw);
                        if (narrowed) setSummaryProgress(narrowed);
                    },
                });
                if (!snapshot) return false;
                if (snapshot.status === "completed") {
                    if (!postIsCurrent()) return true;
                    const data = await reloadSummary();
                    if (postIsCurrent() && data?.summary) {
                        notifySuccess();
                    } else if (postIsCurrent()) {
                        toast.error(
                            "The summary finished but could not be loaded. Reload to try again.",
                        );
                    }
                    return true;
                }
                if (postIsCurrent()) {
                    toast.error(snapshot.error || "Summary generation failed");
                }
                return true;
            };

            try {
                const response = await fetch(summaryUrl(targetId), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        // Opt in to progress. A server that predates streaming
                        // ignores this and answers with JSON, which the branch
                        // below still handles.
                        Accept: "text/event-stream, application/json",
                    },
                    body: JSON.stringify({
                        ...((selectedProfileId ?? summaryProfileId)
                            ? {
                                  profileId:
                                      selectedProfileId ?? summaryProfileId,
                              }
                            : {}),
                        ...(correction?.reviseWithRemarks
                            ? { reviseWithRemarks: true }
                            : {}),
                        ...(correction?.replaceEdited
                            ? { replaceEdited: true }
                            : {}),
                        ...(correction?.summaryId !== undefined
                            ? { summaryId: correction.summaryId }
                            : {}),
                        ...(correction?.revision !== undefined
                            ? { revision: correction.revision }
                            : {}),
                    }),
                });
                if (response.ok) invalidateItemProcessing(targetId);

                const isStream = (
                    response.headers.get("content-type") ?? ""
                ).includes("text/event-stream");

                if (isStream && response.body) {
                    // A streamed response is 200 before the work starts, so a
                    // failure arrives as an event rather than a status code.
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    const parse = createStreamEventParser();
                    let settled = false;
                    let jobId: string | null = null;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        for (const event of parse(
                            decoder.decode(value, { stream: true }),
                        )) {
                            if (event.type === "queued") {
                                // Kept so the work can be followed if this
                                // connection does not survive it.
                                jobId = event.jobId;
                            } else if (event.type === "progress") {
                                if (!postIsCurrent()) continue;
                                setSummaryProgress({
                                    phase: event.phase,
                                    completed: event.completed,
                                    total: event.total,
                                });
                            } else if (event.type === "result") {
                                settled = true;
                                applyResult(event.result as SummaryData);
                            } else if (event.type === "error") {
                                settled = true;
                                if (postIsCurrent()) {
                                    toast.error(
                                        event.error ||
                                            "Summary generation failed",
                                    );
                                }
                            }
                        }
                    }

                    // The stream ended without saying how it went. Since the work
                    // belongs to a job rather than to this request, that almost
                    // always means the connection died and the summary did not --
                    // a deploy, a proxy timeout, a laptop lid. Go and ask.
                    if (!settled && jobId) {
                        settled = await followSummaryJob(jobId);
                    }

                    // No job id, or the job itself could not be found: now the
                    // silence really is all there is to report.
                    if (!settled && postIsCurrent()) {
                        toast.error("Summary generation was interrupted");
                    }
                } else if (response.ok) {
                    applyResult((await response.json()) as SummaryData);
                } else {
                    const error = await response.json().catch(() => ({}));
                    if (postIsCurrent()) {
                        toast.error(error.error || "Summary generation failed");
                    }
                }
            } catch {
                if (postIsCurrent()) {
                    toast.error("Failed to generate summary");
                }
            } finally {
                invalidateItemProcessing(targetId);
                summarizingIdsRef.current = removeSummarizingId(
                    summarizingIdsRef.current,
                    targetId,
                );
                setSummarizingIds(summarizingIdsRef.current);
                summaryStartedAtRef.current = null;
                setSummaryProgress(null);
                setSummaryElapsedMs(0);
            }
        },
        [
            cancelSummaryRead,
            contentView,
            getDisplayedSummary,
            recordingId,
            reloadSummary,
            rememberPresence,
            setSummary,
            summaryProfileId,
            summaryReadPending,
            summarySource,
            summaryUrl,
        ],
    );

    const saveSummary = useCallback(
        async (
            summary: string,
            keyPoints: string[],
            expected: SummaryVersion,
        ): Promise<boolean | "conflict"> => {
            if (!recordingId || !summaryData || summarySource !== "riffado")
                return false;
            const targetId = recordingId;
            const previous = summaryData;
            setSummary({
                ...previous,
                summary,
                keyPoints,
                editedAt: new Date().toISOString(),
            });
            try {
                const response = await fetch(summaryUrl(targetId), {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        summary,
                        keyPoints,
                        ...expected,
                    }),
                });
                if (response.status === 409) {
                    setSummary(previous);
                    return "conflict";
                }
                if (!response.ok) throw new Error("summary edit failed");
                const metadata =
                    (await response.json()) as Partial<SummaryData>;
                setSummary({
                    ...previous,
                    summary,
                    keyPoints,
                    ...metadata,
                });
                return true;
            } catch {
                setSummary(previous);
                return false;
            }
        },
        [recordingId, summaryData, summarySource, setSummary, summaryUrl],
    );

    const handleDeleteSummary = useCallback(async () => {
        if (!recordingId) return;
        const targetId = recordingId;
        const targetSource = summarySource;
        // Optimistic delete -- the summary disappears immediately and
        // only comes back if the server rejects the request.
        const previous = summaryData;
        setSummary(null, { status: "loading", lastOk: false });
        const deleteIsCurrent = () =>
            viewRef.current === contentView &&
            summarySourceRef.current === targetSource &&
            shouldApplySummaryToView(recordingIdRef.current, targetId);

        try {
            const response = await fetch(
                summaryUrl(targetId, `?source=${summarySource}`),
                { method: "DELETE" },
            );
            if (response.ok) {
                invalidateItemProcessing(targetId);
                if (deleteIsCurrent()) {
                    setSummary(null, { status: "ready", lastOk: true });
                    toast.success("Summary deleted");
                    setAvailableSummarySources((current) =>
                        current.filter((source) => source !== summarySource),
                    );
                }
            } else {
                if (deleteIsCurrent()) {
                    setSummary(previous, {
                        status: summaryStatus,
                        lastOk: summaryLoaded,
                    });
                    toast.error("Failed to delete summary");
                }
            }
        } catch {
            if (deleteIsCurrent()) {
                setSummary(previous, {
                    status: summaryStatus,
                    lastOk: summaryLoaded,
                });
                toast.error("Failed to delete summary");
            }
        }
    }, [
        contentView,
        recordingId,
        setSummary,
        summaryData,
        summaryLoaded,
        summarySource,
        summaryStatus,
        summaryUrl,
    ]);

    /**
     * Imperative re-fetch trigger. Use after a re-transcribe call
     * where the server may already have re-summarized -- bumping the
     * key forces a GET without changing recordingId.
     */
    // One interval for the whole hook rather than one per component that
    // renders the clock, and only while something is actually generating.
    useEffect(() => {
        if (!isSummarizing) return;
        const tick = () => {
            const startedAt = summaryStartedAtRef.current;
            if (startedAt != null) setSummaryElapsedMs(Date.now() - startedAt);
        };
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [isSummarizing]);

    /**
     * Read the summary again, keeping what is shown until the answer
     * replaces it: a job queued since (automatic Learn's release) is
     * attached to, and a summary written since is shown.
     */
    const recheckSummary = useCallback(() => {
        setSummaryFetchKey((k) => k + 1);
    }, []);

    const refetchSummary = useCallback(() => {
        const id = recordingIdRef.current;
        if (id) bumpContentGeneration(contentGenByIdRef.current, id);
        setSummaryFetchKey((k) => k + 1);
    }, []);

    return {
        agendaPresence: recordingId ? presenceById[recordingId] : undefined,
        summaryData,
        summaryLoaded,
        summaryStatus,
        availableSummarySources,
        isSummarizing: summarySource === "riffado" && isSummarizing,
        summaryProgress,
        summaryElapsedMs,
        summaryExpanded,
        setSummaryExpanded,
        summaryProfileId,
        setSummaryProfileId,
        summaryProfileOptions,
        summaryProfilesLoading,
        handleSummarize,
        handleDeleteSummary,
        saveSummary,
        refetchSummary,
        recheckSummary,
    };
}
