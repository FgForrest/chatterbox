"use client";

import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
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
    onItemProcessingInvalidated,
    recentItemProcessingInvalidation,
} from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowStatus } from "@/lib/pipeline/workflow-status";
import type { RecordingView } from "@/lib/sharing/view";

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

interface ItemDetailProviderProps {
    itemId: string;
    kind: "audio" | "mail";
    view?: RecordingView;
    isOwn?: boolean;
    enabled?: boolean;
    initialShared?: boolean;
    initialData?: Projection | null;
    operationQueue?: ItemOperationQueue;
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
                    previous.isOwn !== next.isOwn ||
                    previous.enabled !== next.enabled;
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
            workflow: data ? deriveWorkflowStatus(data, kind) : null,
            stale: failures >= 2,
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
        projection,
        queue,
        refresh,
        sharedOnOpen,
        status,
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

/** Read the server's opaque version for an item part, optionally per source. */
export function useItemPartVersion(
    part: keyof NonNullable<Projection["versions"]>,
    source?: string | null,
) {
    const version = useItemDetail()?.versions?.[part];
    if (typeof version === "string") return version;
    if (!source) return undefined;
    return version?.[source];
}
