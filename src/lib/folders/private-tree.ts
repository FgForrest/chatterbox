import { descendantFolderIds } from "@/lib/folders/hierarchy";

/** Only the personal folders rooted in Private, including that root. */
export function privateTreeFolders<
    T extends {
        id: string;
        parentId: string | null;
        kind: string;
        scope: string;
    },
>(folders: readonly T[]): T[] {
    const personal = folders.filter((folder) => folder.scope === "personal");
    const root = personal.find(
        (folder) => folder.kind === "private" && !folder.parentId,
    );
    if (!root) return [];
    const ids = descendantFolderIds(personal, root.id);
    return personal.filter((folder) => ids.has(folder.id));
}
