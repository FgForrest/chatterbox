import type { RecordingFolder } from "@/types/folder";

/** The folder fields that decide its display name. */
export type LabelledFolder = Pick<
    RecordingFolder,
    | "name"
    | "parentId"
    | "kind"
    | "scope"
    | "sharedWithPeople"
    | "receivedFolder"
>;

/** Display roots by kind while preserving user-chosen folder names. */
export function folderDisplayName(
    folder: LabelledFolder,
    labels: { private: string; organization: string },
): string {
    if (folder.parentId === null) {
        if (folder.scope === "org") return labels.organization;
        if (folder.kind === "private") return labels.private;
    }
    return folder.name;
}

/** Build a UI path from labelled folders without changing stored paths. */
export function folderDisplayPath<
    T extends { id: string; parentId: string | null },
>(
    folder: T,
    byId: ReadonlyMap<string, T>,
    label: (folder: T) => string,
    separator = " / ",
): string {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: T | undefined = folder;
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(label(current));
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return names.join(separator);
}
