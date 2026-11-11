import type { RecordingFolder } from "@/types/folder";

/** A tab's readable task folders and ancestors, retaining a readable selected folder. */
export function taskFilterFolders(
    folders: readonly RecordingFolder[],
    taskFolderIds: readonly string[],
    selectedId?: string,
): RecordingFolder[] {
    const readable = folders.filter((folder) => folder.access !== false);
    const byId = new Map(readable.map((folder) => [folder.id, folder]));
    const included = new Set<string>();
    for (const id of [...taskFolderIds, ...(selectedId ? [selectedId] : [])]) {
        let folder = byId.get(id);
        while (folder && !included.has(folder.id)) {
            included.add(folder.id);
            folder = folder.parentId ? byId.get(folder.parentId) : undefined;
        }
    }
    return readable.filter((folder) => included.has(folder.id));
}
