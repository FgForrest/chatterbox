import type { DuplicateKind } from "@/lib/knowledge/duplicate-score";
import type { DuplicatePage } from "@/lib/knowledge/duplicates";

function combinedSignal(
    signal: AbortSignal | undefined,
    timeout: AbortSignal,
): AbortSignal {
    if (!signal) return timeout;
    if (typeof AbortSignal.any !== "function") return signal;
    return AbortSignal.any([signal, timeout]);
}

/** Curator picker ranking includes contrary evidence and remembered dismissals from the queue scorer. */
export async function mergeLikelihoods(
    kind: DuplicateKind,
    sourceId: string,
    signal?: AbortSignal,
): Promise<Map<string, number> | null> {
    try {
        const timeout = AbortSignal.timeout(3000);
        const requestSignal = combinedSignal(signal, timeout);
        const query = new URLSearchParams({ kind, sourceId, limit: "50" });
        const response = await fetch(`/api/knowledge/duplicates?${query}`, {
            signal: requestSignal,
        });
        if (!response.ok) return null;
        const page: DuplicatePage = await response.json();
        return new Map(
            page.candidates.map((pair) => [
                pair.left.id === sourceId ? pair.right.id : pair.left.id,
                pair.score,
            ]),
        );
    } catch {
        return null;
    }
}
