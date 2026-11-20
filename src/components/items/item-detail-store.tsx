"use client";

import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    ItemOperationQueue,
    readItemProcessing,
} from "@/components/items/item-operation-queue";
import { onTasksChanged } from "@/components/tasks/task-api";
import {
    ITEM_PROCESSING_REVALIDATION_MS,
    invalidateItemProcessing,
    onItemProcessingInvalidated,
    recentItemProcessingInvalidation,
} from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import type { RecordingView } from "@/lib/sharing/view";
import {
    preferredTranscript,
    TRANSCRIPT_SOURCE_ORDER,
} from "@/lib/transcription/preferred-source";

type Projection = ItemProcessingPresentation;
type ItemDetailStatus = "loading" | "ready" | "unavailable" | "error";

interface ProjectionState {
    itemId: string;
    sharedOnOpen: boolean;
    projection: Projection | null;
    status: ItemDetailStatus;
    failures: number;
}

interface Scope {
    itemId: string;
    view: RecordingView;
    isOwn: boolean;
    enabled: boolean;
    initialData?: Projection | null;
}

interface RenderedTranscript {
    source: string;
    contentVersion?: string;
}

interface ItemDetailProviderProps {
    itemId: string;
    kind: "audio" | "mail";
    view?: RecordingView;
    isOwn?: boolean;
    enabled?: boolean;
    initialShared?: boolean;
    initialData?: Projection | null;
    operationQueue?: ItemOperationQueue;
    transcripts?: readonly RenderedTranscript[];
    titleVersion?: string;
    renderedHasSummary?: boolean;
    refreshDashboard?: () => void;
    detailVisible?: boolean;
    children: ReactNode;
}

interface ItemDetail {
    itemId: string;
    projection: Projection | null;
    data: Projection | null;
    status: ItemDetailStatus;
    access: Projection["access"];
    versions: Projection["versions"];
    shared: boolean;
    workflow: ReturnType<typeof deriveWorkflowStatus> | null;
    stale: boolean;
    transcriptSource: string | undefined;
    selectTranscript: (source: string) => void;
    revalidateTranscript: () => void;
    pendingTranscripts: ReadonlySet<string>;
    refresh: () => Promise<void>;
    enqueueOperation: ItemOperationQueue["enqueueOperation"];
    pendingFolderIds: ReadonlySet<string>;
    pendingRemovedFolderIds: ReadonlySet<string>;
    pendingProfile: boolean;
    pendingIntents: boolean;
    pendingProcessAgain: boolean;
    previewFolderIds: (ids: string[]) => string[];
    folderIdsForGate: (ids: string[]) => string[];
}

const ItemDetailContext = createContext<ItemDetail | null>(null);
const TRANSCRIPT_REFRESH_RETRY_MS = 10_000;

interface RenderedPartRefresh {
    version: string;
    retryAt: number | null;
}

function useRenderedItemRefresh(
    itemId: string,
    versions: Projection["versions"],
    transcripts: readonly RenderedTranscript[] | undefined,
    titleVersion: string | undefined,
    renderedHasSummary: boolean | undefined,
    projectedHasSummary: boolean | undefined,
    refreshDashboard: (() => void) | undefined,
) {
    const requested = useRef<{
        itemId: string;
        parts: Map<string, RenderedPartRefresh>;
    } | null>(null);
    const [released, setReleased] = useState<{
        itemId: string;
        parts: Map<string, string>;
    } | null>(null);
    if (released && released.itemId !== itemId) setReleased(null);
    const serverVersions = useMemo(() => {
        if (
            !versions ||
            !transcripts ||
            titleVersion === undefined ||
            !refreshDashboard
        )
            return null;
        return new Map([
            ...Object.entries(versions.transcripts),
            ["title", versions.title],
            ["summary-flag", String(projectedHasSummary)],
        ]);
    }, [
        projectedHasSummary,
        refreshDashboard,
        titleVersion,
        transcripts,
        versions,
    ]);
    const mismatches = useMemo(() => {
        const parts = new Set<string>();
        if (!serverVersions || !versions || !transcripts) return parts;
        const rendered = new Map(
            transcripts.map(({ source, contentVersion }) => [
                source,
                contentVersion,
            ]),
        );
        for (const source of new Set([
            ...rendered.keys(),
            ...Object.keys(versions.transcripts),
        ])) {
            if (rendered.get(source) !== versions.transcripts[source])
                parts.add(source);
        }
        if (versions.title !== titleVersion) parts.add("title");
        if (
            renderedHasSummary !== undefined &&
            renderedHasSummary !== projectedHasSummary
        )
            parts.add("summary-flag");
        return parts;
    }, [
        projectedHasSummary,
        renderedHasSummary,
        serverVersions,
        titleVersion,
        transcripts,
        versions,
    ]);
    const pendingTranscripts = useMemo(() => {
        const pending = new Set<string>();
        for (const source of mismatches) {
            const version = versions?.transcripts[source];
            if (
                version !== undefined &&
                (released?.itemId !== itemId ||
                    released.parts.get(source) !== version)
            )
                pending.add(source);
        }
        return pending;
    }, [itemId, mismatches, released, versions]);

    useEffect(() => {
        if (!serverVersions || !refreshDashboard) return;
        if (requested.current?.itemId !== itemId)
            requested.current = { itemId, parts: new Map() };
        const { parts } = requested.current;
        const superseded = [...parts].filter(
            ([name, entry]) =>
                entry.version !== (serverVersions.get(name) ?? ""),
        );
        for (const [name] of superseded) parts.delete(name);
        if (superseded.length > 0 && released?.itemId === itemId) {
            const next = new Map(released.parts);
            for (const [name] of superseded) next.delete(name);
            if (next.size !== released.parts.size)
                setReleased({ itemId, parts: next });
        }

        let shouldRefresh = false;
        const deadline = Date.now() + TRANSCRIPT_REFRESH_RETRY_MS;
        for (const name of mismatches) {
            if (parts.has(name)) continue;
            parts.set(name, {
                version: serverVersions.get(name) ?? "",
                retryAt: pendingTranscripts.has(name) ? deadline : null,
            });
            shouldRefresh = true;
        }
        const waiting = [...pendingTranscripts].flatMap((source) => {
            const entry = parts.get(source);
            return entry?.retryAt != null
                ? [{ source, entry, at: entry.retryAt }]
                : [];
        });
        if (shouldRefresh) refreshDashboard();
        if (waiting.length === 0) return;
        const retryAt = Math.min(...waiting.map(({ at }) => at));
        const timer = window.setTimeout(
            () => {
                const next = new Map(
                    released?.itemId === itemId ? released.parts : undefined,
                );
                for (const { source, entry, at } of waiting) {
                    if (at > retryAt) continue;
                    entry.retryAt = null;
                    next.set(source, entry.version);
                }
                setReleased({ itemId, parts: next });
                refreshDashboard();
            },
            Math.max(0, retryAt - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [
        itemId,
        mismatches,
        pendingTranscripts,
        refreshDashboard,
        released,
        serverVersions,
    ]);

    return pendingTranscripts;
}

/** Own the processing projection and its polling, keyed by itemId. */
export function ItemDetailProvider({
    itemId,
    kind,
    view = "private",
    isOwn = false,
    enabled = true,
    initialShared = false,
    initialData,
    operationQueue,
    transcripts,
    titleVersion,
    renderedHasSummary,
    refreshDashboard,
    detailVisible = true,
    children,
}: ItemDetailProviderProps) {
    const localQueue = useMemo(() => new ItemOperationQueue(itemId), [itemId]);
    const queue = operationQueue ?? localQueue;
    const pending = useSyncExternalStore(
        queue.subscribe,
        queue.getSnapshot,
        queue.getSnapshot,
    );
    const cached = view !== "received" ? queue.getProjection() : null;
    const newItemState: ProjectionState = {
        itemId,
        sharedOnOpen: initialShared,
        projection: cached,
        status: cached ? "ready" : "loading",
        failures: 0,
    };
    const [state, setState] = useState(newItemState);
    const currentState = state.itemId === itemId ? state : newItemState;
    if (currentState !== state) setState(currentState);

    const controls = useRef<{
        configure: (next: Scope) => void;
        refresh: () => Promise<void>;
    } | null>(null);

    useLayoutEffect(() => {
        let scope: Scope | undefined;
        let scopeRevision = 0;
        let projection = queue.getProjection();
        let status: ItemDetailStatus = "loading";
        let disposed = false;
        let inFlight: Promise<void> | null = null;
        let activeRead: AbortController | null = null;
        let refreshQueued = false;
        let timer: number | undefined;
        let serverDelay = 60_000;
        let series: {
            baseline: string | undefined;
            until: number;
            delay: number;
        } | null = null;

        const visible = () => document.visibilityState === "visible";
        const canRead = () =>
            !disposed &&
            scope?.enabled &&
            scope.view !== "received" &&
            visible();

        function accept(next: Projection) {
            projection = next;
            status = "ready";
            serverDelay = Math.max(3_000, next.nextCheckInMs);
            setState((current) =>
                current.itemId === itemId
                    ? {
                          ...current,
                          projection: next,
                          status: "ready",
                          failures: 0,
                      }
                    : current,
            );
        }

        function schedule() {
            window.clearTimeout(timer);
            if (!canRead() || status === "unavailable" || inFlight) return;
            const now = Date.now();
            const invalidatedAt = recentItemProcessingInvalidation(itemId);
            const waitingForArrival =
                !projection?.phases.categorize &&
                invalidatedAt !== null &&
                now + 3_000 <= invalidatedAt + ITEM_PROCESSING_REVALIDATION_MS;
            const retry = series;
            const remaining = retry ? retry.until - now : 0;
            let delay = serverDelay;
            if (waitingForArrival) delay = 3_000;
            else if (retry && remaining > 0)
                delay = Math.min(retry.delay, remaining);
            timer = window.setTimeout(() => {
                if (!waitingForArrival && retry && series === retry)
                    retry.delay *= 2;
                void refresh();
            }, delay);
        }

        function refresh(afterPending = false): Promise<void> {
            if (!scope || !canRead()) return Promise.resolve();
            if (inFlight) {
                refreshQueued ||= afterPending;
                return inFlight;
            }
            window.clearTimeout(timer);
            const revision = scopeRevision;
            const startedSeries = series;
            const awaiting = queue
                .getSnapshot()
                .filter((entry) => entry.awaitingRead);
            const stillCurrent = () => !disposed && revision === scopeRevision;

            const controller = new AbortController();
            activeRead = controller;
            const { signal } = controller;
            const requestScope = scope;
            const deadline = window.setTimeout(
                () => controller.abort(),
                20_000,
            );
            const response = new Promise<
                Awaited<ReturnType<typeof readItemProcessing>>
            >((resolve, reject) => {
                const onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
                void readItemProcessing(
                    itemId,
                    {
                        kind,
                        view: requestScope.view,
                        isOwn:
                            requestScope.isOwn ||
                            projection?.access?.role === "owner",
                    },
                    signal,
                    visible,
                )
                    .then(resolve, reject)
                    .finally(() =>
                        signal.removeEventListener("abort", onAbort),
                    );
            });
            inFlight = response
                .then((next) => {
                    if (!stillCurrent() || next === undefined) return;
                    if (!next) {
                        queue.acceptRead(null, awaiting);
                        status = "unavailable";
                        if (series === startedSeries) series = null;
                        setState((current) =>
                            current.itemId === itemId
                                ? { ...current, status: "unavailable" }
                                : current,
                        );
                        return;
                    }
                    const itemVersion = next.versions?.item;
                    if (series && itemVersion !== undefined) {
                        if (series.baseline === undefined) {
                            series.baseline = itemVersion;
                        } else if (
                            series === startedSeries &&
                            itemVersion !== series.baseline
                        ) {
                            series = null;
                        }
                    }
                    accept(next);
                    queue.acceptRead(next, awaiting);
                })
                .catch(() => {
                    if (!stillCurrent()) return;
                    status = "error";
                    serverDelay = 5_000;
                    setState((current) =>
                        current.itemId === itemId
                            ? {
                                  ...current,
                                  status: "error",
                                  failures: current.failures + 1,
                              }
                            : current,
                    );
                })
                .finally(() => {
                    window.clearTimeout(deadline);
                    activeRead = null;
                    inFlight = null;
                    if (refreshQueued) {
                        refreshQueued = false;
                        void refresh();
                    } else {
                        schedule();
                    }
                });
            return inFlight;
        }

        function invalidate(at: number) {
            series = {
                baseline: projection?.versions?.item,
                until: at + ITEM_PROCESSING_REVALIDATION_MS,
                delay: 1_000,
            };
            void refresh(true);
        }

        const disconnect = queue.connect({
            scope: () => ({
                kind,
                view: scope?.view ?? "private",
                isOwn: scope?.isOwn ?? false,
            }),
            canLoadProjection: () => Boolean(canRead()),
            accept(next) {
                // A read that began before this answer can describe the pre-write state.
                scopeRevision++;
                activeRead?.abort();
                if (next) accept(next);
                else status = "unavailable";
                schedule();
            },
        });
        controls.current = {
            refresh,
            configure(next) {
                if (next.itemId !== itemId) return;
                const previous = scope;
                scope = next;
                const scopeChanged =
                    previous?.view !== next.view ||
                    previous?.isOwn !== next.isOwn ||
                    previous?.enabled !== next.enabled;
                if (scopeChanged) {
                    scopeRevision++;
                    activeRead?.abort();
                }
                if (
                    next.initialData?.itemId === itemId &&
                    next.initialData !== previous?.initialData
                ) {
                    accept(next.initialData);
                    queue.acceptRead(next.initialData, []);
                }
                const recent = previous
                    ? null
                    : recentItemProcessingInvalidation(itemId);
                if (recent !== null) {
                    invalidate(recent);
                } else if (
                    scopeChanged &&
                    (previous || next.initialData === undefined)
                ) {
                    window.clearTimeout(timer);
                    void refresh(true);
                } else {
                    schedule();
                }
            },
        };
        const onFocus = () => void refresh();
        const onVisibility = () => {
            if (visible()) void refresh();
            else {
                window.clearTimeout(timer);
                queue.revalidateWithoutDetail();
            }
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        const unsubscribe = onItemProcessingInvalidated(itemId, invalidate);
        const unsubscribeTasks = onTasksChanged(() => void refresh(true));

        return () => {
            disposed = true;
            activeRead?.abort();
            controls.current = null;
            window.clearTimeout(timer);
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibility);
            unsubscribe();
            unsubscribeTasks();
            disconnect();
        };
    }, [itemId, kind, queue]);

    useLayoutEffect(() => {
        controls.current?.configure({
            itemId,
            view,
            isOwn,
            enabled,
            initialData,
        });
        queue.revalidateWithoutDetail();
    }, [enabled, initialData, isOwn, itemId, queue, view]);

    const refresh = useCallback(
        () => controls.current?.refresh() ?? Promise.resolve(),
        [],
    );
    const { projection, status, failures, sharedOnOpen } = currentState;
    const workflowOnItem = useMemo(
        () => (projection ? deriveWorkflowStatus(projection, kind) : null),
        [projection, kind],
    );
    const pendingTranscripts = useRenderedItemRefresh(
        itemId,
        projection?.versions,
        transcripts,
        titleVersion,
        renderedHasSummary,
        projection?.outputs.summary,
        refreshDashboard,
    );

    const visibleItemId = detailVisible ? itemId : null;
    const sourceOrder: readonly string[] = TRANSCRIPT_SOURCE_ORDER;
    const workflowSource = preferredTranscript(transcripts ?? [])?.source;
    const workflowRank = sourceOrder.indexOf(workflowSource ?? "");
    const [tab, setTab] = useState<{
        itemId: string | null;
        workflowDefault?: boolean;
        source?: string;
        workflowRank: number;
        sawWorkflow: boolean;
        canFollowArrival: boolean;
    }>({
        itemId: visibleItemId,
        workflowRank,
        sawWorkflow: false,
        canFollowArrival: true,
    });
    const continuing = visibleItemId !== null && tab.itemId === visibleItemId;
    const selected = continuing ? tab.source : undefined;
    const initialDefault =
        !enabled || view === "received" || status === "unavailable"
            ? false
            : workflowOnItem?.visible;
    let workflowDefault: boolean | undefined;
    if (visibleItemId !== null) {
        workflowDefault = initialDefault;
        if (continuing) workflowDefault = tab.workflowDefault ?? initialDefault;
    }
    let fallback: string | undefined;
    if (transcripts) {
        if (workflowDefault !== false) {
            fallback = workflowSource;
        }
        fallback ??= transcripts[0]?.source;
    }
    const sawWorkflow =
        visibleItemId !== null &&
        (initialDefault === true || (continuing && tab.sawWorkflow));
    const mayFollowArrival = !continuing || tab.canFollowArrival;
    const selectedRank = sourceOrder.indexOf(selected ?? "");
    const followsArrival =
        continuing &&
        mayFollowArrival &&
        sawWorkflow &&
        workflowRank >= 0 &&
        workflowRank < selectedRank &&
        (tab.workflowRank < 0 || workflowRank < tab.workflowRank);
    const canFollowArrival = mayFollowArrival && !followsArrival;
    let shown = fallback;
    if (followsArrival) {
        shown = workflowSource;
    } else if (
        selected &&
        transcripts?.some(({ source }) => source === selected)
    ) {
        shown = selected;
    }
    let remembered: string | undefined;
    if (!followsArrival && selected && pendingTranscripts.has(selected)) {
        remembered = selected;
    } else if (selected !== undefined || workflowDefault !== undefined) {
        remembered = shown;
    }
    if (
        tab.itemId !== visibleItemId ||
        tab.workflowDefault !== workflowDefault ||
        tab.source !== remembered ||
        tab.workflowRank !== workflowRank ||
        tab.sawWorkflow !== sawWorkflow ||
        tab.canFollowArrival !== canFollowArrival
    )
        setTab({
            itemId: visibleItemId,
            workflowDefault,
            source: remembered,
            workflowRank,
            sawWorkflow,
            canFollowArrival,
        });
    const selectTranscript = useCallback(
        (source: string) => {
            if (visibleItemId !== null)
                setTab((current) => ({
                    ...current,
                    itemId: visibleItemId,
                    source,
                    canFollowArrival: false,
                }));
        },
        [visibleItemId],
    );
    const revalidateTranscript = useCallback(() => {
        if (titleVersion !== undefined && enabled && view !== "received")
            invalidateItemProcessing(itemId);
        else refreshDashboard?.();
    }, [enabled, itemId, refreshDashboard, titleVersion, view]);

    const value = useMemo<ItemDetail>(() => {
        const operations = pending.map((entry) => entry.operation);
        const data = operations.reduce(
            (current, operation) =>
                current && operation.apply ? operation.apply(current) : current,
            projection,
        );
        return {
            itemId,
            projection,
            data,
            status,
            access: projection?.access,
            versions: projection?.versions,
            shared: projection
                ? (projection.access?.shared ?? false)
                : sharedOnOpen,
            workflow:
                data === projection
                    ? workflowOnItem
                    : data && deriveWorkflowStatus(data, kind),
            stale: failures >= 2,
            transcriptSource: shown,
            selectTranscript,
            revalidateTranscript,
            pendingTranscripts,
            refresh,
            enqueueOperation: queue.enqueueOperation,
            pendingFolderIds: new Set(
                operations.flatMap(({ folders }) => folders?.pendingIds ?? []),
            ),
            pendingRemovedFolderIds: new Set(
                pending.flatMap(({ operation, awaitingRead }) =>
                    awaitingRead ? [] : (operation.folders?.removedIds ?? []),
                ),
            ),
            pendingProfile: operations.some(
                (operation) => operation.pendingProfile,
            ),
            pendingIntents: operations.some(
                (operation) => operation.pendingIntents,
            ),
            pendingProcessAgain: operations.some(
                (operation) => operation.pendingProcessAgain,
            ),
            folderIdsForGate: (ids) => queue.folderIdsForGate(ids),
            previewFolderIds: (ids) =>
                operations.reduce(
                    (current, { folders }) =>
                        folders?.apply(current) ?? current,
                    ids,
                ),
        };
    }, [
        failures,
        itemId,
        kind,
        pending,
        pendingTranscripts,
        projection,
        queue,
        refresh,
        revalidateTranscript,
        selectTranscript,
        sharedOnOpen,
        shown,
        status,
        workflowOnItem,
    ]);

    return (
        <ItemDetailContext.Provider value={value}>
            {children}
        </ItemDetailContext.Provider>
    );
}

/** Read the open item's projection, when rendered inside its detail pane. */
export function useItemDetail() {
    return useContext(ItemDetailContext);
}

/** Resolve content scope using the authorized projection and the first-load sharing hint. */
export function useItemContentView(
    view: RecordingView | undefined,
    shared = false,
) {
    const detail = useItemDetail();
    if (view === "received") return view;
    if (detail?.projection) return detail.access?.contentView ?? view;
    return (detail?.shared ?? shared) ? "org" : view;
}

/** Read an opaque part version. An empty string marks a missing source in a loaded version map. */
export function useItemPartVersion(
    part: keyof NonNullable<Projection["versions"]>,
    source?: string | null,
) {
    const version = useItemDetail()?.versions?.[part];
    if (typeof version === "string") return version;
    if (!version || !source) return undefined;
    return version[source] ?? "";
}
