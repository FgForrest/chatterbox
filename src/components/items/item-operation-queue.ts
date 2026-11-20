import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

type Projection = ItemProcessingPresentation;
type Placement =
    | "shared"
    | "filed"
    | "intended"
    | "withheld"
    | "removed"
    | "unshared"
    | "unchanged"
    | "categorized"
    | "confirmed";

export interface ItemOperationResult {
    processing?: Projection | null;
    processingStale?: true;
    placement?: Placement;
    removal?: "removed" | "unshared";
}

export interface FolderEdit {
    apply: (folderIds: string[]) => string[];
    pendingIds: readonly string[];
    addedIds?: readonly string[];
    removedIds?: readonly string[];
}

export interface ItemOperation {
    apply?: (projection: Projection) => Projection;
    folders?: FolderEdit;
    pendingProfile?: boolean;
    pendingIntents?: boolean;
    pendingProcessAgain?: boolean;
    write: (
        projection: Projection | null,
        view: RecordingView,
    ) => Promise<ItemOperationResult>;
}

export type TrackFolderEdit = (
    itemId: string,
    edit: FolderEdit,
) => (outcome?: ItemOperationResult) => void;

interface PendingOperation {
    operation: ItemOperation;
    finishFolderEdit?: ReturnType<TrackFolderEdit>;
    awaitingRead?: { outcome: ItemOperationResult; resolve: () => void };
}

interface ItemReadScope {
    kind: "audio" | "mail";
    view: RecordingView;
    isOwn: boolean;
}

const DETACHED_READ_LIMIT_MS = 5 * 60_000;
const PROJECTION_READ_TIMEOUT_MS = 20_000;

interface DetachedRead {
    entry: PendingOperation;
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout>;
}

interface OpenItem {
    scope: () => ItemReadScope;
    canLoadProjection: () => boolean;
    accept: (projection: Projection | null) => void;
}

/** Serialize writes and retain their overlays for the lifetime of an open item's queue. */
export class ItemOperationQueue {
    private pending: PendingOperation[] = [];
    private listeners = new Set<() => void>();
    private tail = Promise.resolve();
    private openItem: OpenItem | undefined;
    private projection: Projection | null = null;
    private detachedRead: DetachedRead | undefined;
    private disposed = false;

    constructor(
        private itemId: string,
        private trackFolderEdit?: TrackFolderEdit,
        private lastScope: ItemReadScope = {
            kind: "audio",
            view: "private",
            isOwn: false,
        },
        private lifecycle: {
            onActive?: () => void;
            onIdle?: () => void;
            onReadExpired?: () => void;
        } = {},
    ) {}

    getSnapshot = () => this.pending;

    getProjection = () => this.projection;

    previewFolderIds(folderIds: string[]) {
        return this.pending.reduce(
            (ids, { operation }) => operation.folders?.apply(ids) ?? ids,
            folderIds,
        );
    }

    folderIdsForGate(folderIds: string[]) {
        return this.pending.reduce((ids, { operation, awaitingRead }) => {
            const folders = operation.folders;
            if (!folders) return ids;
            const outcome = awaitingRead?.outcome;
            const removed =
                outcome?.placement === "removed" ||
                outcome?.placement === "unshared" ||
                outcome?.removal;
            return editFolderIds(
                ids,
                outcome?.placement === "intended" ||
                    outcome?.placement === "unchanged"
                    ? []
                    : (folders.addedIds ?? []),
                removed ? folders.removedIds : undefined,
            );
        }, folderIds);
    }

    isIdle() {
        return this.pending.length === 0 && !this.openItem;
    }

    dispose() {
        this.disposed = true;
        this.stopDetachedRead();
        for (const entry of this.pending) entry.awaitingRead?.resolve();
        this.openItem = undefined;
        this.publish([]);
        this.listeners.clear();
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    connect(openItem: OpenItem) {
        this.openItem = openItem;
        this.lifecycle.onActive?.();
        return () => {
            if (this.openItem !== openItem) return;
            this.lastScope = openItem.scope();
            this.openItem = undefined;
            this.revalidateWithoutDetail();
            if (this.isIdle()) this.lifecycle.onIdle?.();
        };
    }

    acceptRead(projection: Projection | null, awaiting: PendingOperation[]) {
        this.projection = projection;
        for (const entry of awaiting) {
            if (!entry.awaitingRead || !this.pending.includes(entry)) continue;
            if (this.detachedRead?.entry === entry) this.stopDetachedRead();
            this.settle(entry, {
                ...entry.awaitingRead.outcome,
                processing: projection,
            });
            entry.awaitingRead.resolve();
        }
    }

    revalidateWithoutDetail() {
        if (
            this.disposed ||
            this.openItem?.canLoadProjection() ||
            this.detachedRead
        )
            return;
        const entry = this.pending.find((pending) => pending.awaitingRead);
        if (!entry) return;
        const controller = new AbortController();
        const deadline = setTimeout(() => {
            for (const pending of this.pending) pending.finishFolderEdit?.();
            this.dispose();
            this.lifecycle.onReadExpired?.();
        }, DETACHED_READ_LIMIT_MS);
        const read = { entry, controller, deadline };
        this.detachedRead = read;
        void this.readWithoutDetail(read).finally(() => {
            if (this.detachedRead !== read) return;
            this.stopDetachedRead();
            this.revalidateWithoutDetail();
        });
    }

    private stopDetachedRead() {
        const read = this.detachedRead;
        if (!read) return;
        this.detachedRead = undefined;
        clearTimeout(read.deadline);
        read.controller.abort();
    }

    private async readWithoutDetail({ entry, controller }: DetachedRead) {
        const { signal } = controller;
        let delay = 1_000;
        while (!signal.aborted) {
            try {
                const scope = this.openItem?.scope() ?? this.lastScope;
                const request = new AbortController();
                const timeout = setTimeout(
                    () => request.abort(),
                    PROJECTION_READ_TIMEOUT_MS,
                );
                const abort = () => {
                    clearTimeout(timeout);
                    request.abort();
                };
                signal.addEventListener("abort", abort, { once: true });
                try {
                    const result = await readItemProcessing(
                        this.itemId,
                        {
                            ...scope,
                            isOwn:
                                scope.isOwn ||
                                this.projection?.access?.role === "owner",
                        },
                        request.signal,
                    );
                    if (result !== undefined && !signal.aborted) {
                        this.openItem?.accept(result);
                        this.acceptRead(result, [entry]);
                    }
                    return;
                } finally {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", abort);
                }
            } catch {
                if (signal.aborted) return;
                await new Promise<void>((resolve) => {
                    const abort = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                    const timer = setTimeout(() => {
                        signal.removeEventListener("abort", abort);
                        resolve();
                    }, delay);
                    signal.addEventListener("abort", abort, { once: true });
                });
                delay = Math.min(delay * 2, 30_000);
            }
        }
    }

    private publish(pending: PendingOperation[]) {
        this.pending = pending;
        for (const listener of this.listeners) listener();
        if (!this.disposed && this.isIdle()) this.lifecycle.onIdle?.();
    }

    private settle(entry: PendingOperation, outcome?: ItemOperationResult) {
        entry.finishFolderEdit?.(outcome);
        this.publish(this.pending.filter((pending) => pending !== entry));
    }

    enqueueOperation = (
        operation: ItemOperation,
    ): Promise<ItemOperationResult> => {
        if (this.disposed)
            return Promise.reject(new Error("Item operation queue closed"));
        this.lifecycle.onActive?.();
        const entry: PendingOperation = {
            operation,
            finishFolderEdit:
                operation.folders &&
                this.trackFolderEdit?.(this.itemId, operation.folders),
        };
        this.publish([...this.pending, entry]);
        let settlement: Promise<void> | undefined;
        const run = this.tail.then(async () => {
            if (this.disposed) throw new Error("Item operation queue closed");
            let outcome: ItemOperationResult;
            try {
                outcome = await operation.write(
                    this.projection,
                    (this.openItem?.scope() ?? this.lastScope).view,
                );
            } catch (error) {
                if (!this.disposed) this.settle(entry);
                throw error;
            }
            if (this.disposed) return outcome;
            if (outcome.processing === undefined || outcome.processingStale) {
                settlement = new Promise<void>((resolve) => {
                    entry.awaitingRead = { outcome, resolve };
                });
                this.publish([...this.pending]);
                invalidateItemProcessing(this.itemId);
                this.revalidateWithoutDetail();
            } else {
                this.projection = outcome.processing;
                this.openItem?.accept(outcome.processing);
                this.settle(entry, outcome);
                if (!outcome.processing) invalidateItemProcessing(this.itemId);
            }
            return outcome;
        });
        this.tail = run.then(
            () => settlement,
            () => {},
        );
        return run;
    };
}

/** Retain each item's queue while a detail is connected or a write still needs it. */
export class ItemOperationRegistry {
    private queues = new Map<string, ItemOperationQueue>();

    constructor(
        private trackFolderEdit: TrackFolderEdit,
        private onReadExpired: () => void,
    ) {}

    find(itemId: string) {
        return this.queues.get(itemId);
    }

    get(itemId: string, scope: ItemReadScope) {
        const existing = this.queues.get(itemId);
        if (existing) return existing;
        const evict = () => {
            if (this.queues.get(itemId) !== queue) return;
            this.queues.delete(itemId);
        };
        const queue = new ItemOperationQueue(
            itemId,
            this.trackFolderEdit,
            scope,
            {
                onActive: () => {
                    const registered = this.queues.get(itemId);
                    if (!registered || registered.isIdle())
                        this.queues.set(itemId, queue);
                },
                onIdle: () =>
                    queueMicrotask(() => {
                        if (queue.isIdle()) evict();
                    }),
                onReadExpired: () => {
                    evict();
                    this.onReadExpired();
                },
            },
        );
        this.queues.set(itemId, queue);
        return queue;
    }

    clear() {
        for (const queue of this.queues.values()) queue.dispose();
        this.queues.clear();
    }
}

function isUnavailable(response: Response) {
    return [401, 403, 404].includes(response.status);
}

/** Read the item's processing state, with the owner's private view as a fallback. */
export async function readItemProcessing(
    itemId: string,
    { kind, view, isOwn }: ItemReadScope,
    signal: AbortSignal,
    canReadFallback = () => true,
) {
    const path = `/api/${kind === "mail" ? "mail" : "recordings"}/${encodeURIComponent(itemId)}?processing=1`;
    let response = await fetch(withRecordingView(path, view), { signal });
    signal.throwIfAborted();
    if (isUnavailable(response) && view === "org" && isOwn) {
        if (!canReadFallback()) return undefined;
        response = await fetch(path, { signal });
        signal.throwIfAborted();
    }
    if (isUnavailable(response)) return null;
    if (!response.ok) throw new Error(String(response.status));

    const { processing } = (await response.json()) as {
        processing?: Projection | null;
    };
    signal.throwIfAborted();
    if (processing === null && view === "received") return null;
    if (
        !processing ||
        processing.itemId !== itemId ||
        !Number.isFinite(processing.nextCheckInMs) ||
        processing.nextCheckInMs < 0
    ) {
        throw new Error("Invalid processing response");
    }
    return processing;
}

/** Parse a successful item write response, including writes with no projection. */
export async function itemOperationResult(
    response: Response,
): Promise<ItemOperationResult> {
    return (await response.json().catch(() => null)) ?? {};
}

/** Apply additions and removals to a single item's folder assignments. */
export function editFolderIds(
    folderIds: string[],
    add: readonly string[],
    remove: readonly string[] = [],
) {
    return [
        ...new Set([...folderIds.filter((id) => !remove.includes(id)), ...add]),
    ];
}
