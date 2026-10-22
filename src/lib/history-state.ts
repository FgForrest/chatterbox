const NEXT_HISTORY_KEYS = new Set([
    "__NA",
    "_N",
    "__N",
    "__PRIVATE_NEXTJS_INTERNALS_TREE",
]);

/** Current application state for history writes that synchronize Next's URL. */
export function getAppHistoryState(): Record<string, unknown> {
    const state: unknown = window.history.state;
    if (state === null || typeof state !== "object") return {};
    return Object.fromEntries(
        Object.entries(state).filter(([key]) => !NEXT_HISTORY_KEYS.has(key)),
    );
}
