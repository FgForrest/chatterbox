import { createHash } from "node:crypto";
import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import type { PipelineView } from "@/lib/pipeline/types";

/** Hash the canonical sorted folder scope without exposing folder ids. */
export function scopeFingerprint(folderIds: readonly string[]): string {
    return createHash("sha256")
        .update([...new Set(folderIds)].sort().join("\0"))
        .digest("hex");
}

/** Read and hash the current folder scope of one owner-scoped item view. */
export async function itemScopeFingerprint(
    itemId: string,
    view: PipelineView,
    ownerUserId: string,
): Promise<string> {
    return scopeFingerprint(
        await itemScopeFolderIds(itemId, view, ownerUserId),
    );
}
