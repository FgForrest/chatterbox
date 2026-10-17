const ITEM_PROCESSING_INVALIDATED = "riffado:item-processing-invalidated";
const RECENT_INVALIDATION_MS = 30_000;

const invalidatedAt = new Map<string, number>();

function pruneInvalidations(now: number): void {
    for (const [itemId, at] of invalidatedAt) {
        if (now - at > RECENT_INVALIDATION_MS) invalidatedAt.delete(itemId);
    }
}

/** Ask every mounted projection of an item to refetch until its state moves. */
export function invalidateItemProcessing(itemId: string): void {
    const now = Date.now();
    pruneInvalidations(now);
    invalidatedAt.set(itemId, now);
    if (typeof window === "undefined") return;
    window.dispatchEvent(
        new CustomEvent(ITEM_PROCESSING_INVALIDATED, { detail: { itemId } }),
    );
}

/** Return a recent invalidation so a newly mounted item can continue it. */
export function recentItemProcessingInvalidation(
    itemId: string,
): number | null {
    const now = Date.now();
    pruneInvalidations(now);
    return invalidatedAt.get(itemId) ?? null;
}

/** Listen for processing invalidations for one item. */
export function onItemProcessingInvalidated(
    itemId: string,
    listener: (at: number) => void,
): () => void {
    const handle = (event: Event) => {
        const detail = (event as CustomEvent<{ itemId?: unknown }>).detail;
        if (detail?.itemId !== itemId) return;
        listener(Date.now());
    };
    window.addEventListener(ITEM_PROCESSING_INVALIDATED, handle);
    return () =>
        window.removeEventListener(ITEM_PROCESSING_INVALIDATED, handle);
}

/** How long an invalidated idle projection waits for delayed server work. */
export const ITEM_PROCESSING_REVALIDATION_MS = RECENT_INVALIDATION_MS;
