import {
    descendantFolderIds,
    effectiveRecordingCounts,
} from "@/lib/folders/hierarchy";
import { folderDisplayPath } from "@/lib/folders/labels";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

export interface FolderMatch {
    folder: RecordingFolder;
    path: string;
    depth: number;
    nameMatch: boolean;
}

export interface FolderNavigation {
    counts: ReadonlyMap<string, number>;
    activity: ReadonlyMap<string, number>;
    entries: FolderMatch[];
}

export function libraryNavigation(
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    recordings: Recording[],
    label: (folder: RecordingFolder) => string,
): FolderNavigation {
    return {
        counts: effectiveRecordingCounts(
            folders,
            assignments,
            recordings.map((item) => item.id),
            recordings
                .filter((item) => item.view !== "org")
                .map((item) => item.id),
        ),
        activity: folderActivity(folders, assignments, recordings),
        entries: matchFolders(folders, "", label),
    };
}

export function joinFolderPath(
    parentPath: string | undefined,
    name: string,
): string {
    return [parentPath, name].filter(Boolean).join(" › ");
}

export function matchFolderEntries(
    entries: FolderMatch[],
    query: string,
    label: (folder: RecordingFolder) => string,
): FolderMatch[] {
    const normalized = normalizeFolderQuery(query);
    if (!normalized) return entries;
    return entries
        .map((entry) => ({
            ...entry,
            nameMatch: normalizeFolderQuery(label(entry.folder)).includes(
                normalized,
            ),
        }))
        .filter(
            (entry) =>
                entry.nameMatch ||
                normalizeFolderQuery(
                    joinFolderPath(entry.path, label(entry.folder)),
                ).includes(normalized),
        )
        .sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch));
}

export function normalizeFolderQuery(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase()
        .trim();
}

export function orderedFolders(
    folders: readonly RecordingFolder[],
): RecordingFolder[] {
    return [...folders].sort((a, b) => {
        if (a.parentId === null && b.parentId === null && a.scope !== b.scope)
            return a.scope === "personal" ? -1 : 1;
        return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    });
}

function pathDepth(
    folder: RecordingFolder,
    byId: ReadonlyMap<string, RecordingFolder>,
): number {
    const seen = new Set<string>([folder.id]);
    let parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return seen.size - 1;
}

export function matchFolders(
    folders: readonly RecordingFolder[],
    query: string,
    label: (folder: RecordingFolder) => string = (folder) => folder.name,
): FolderMatch[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const ordered = orderedFolders(folders);
    const result = ordered.map((folder) => {
        const path = folder.parentId
            ? folderDisplayPath(
                  byId.get(folder.parentId) ?? folder,
                  byId,
                  label,
                  " › ",
              )
            : "";
        return {
            folder,
            path,
            depth: pathDepth(folder, byId),
            nameMatch: true,
        };
    });
    const children = new Map<string | null, RecordingFolder[]>();
    for (const folder of ordered) {
        const level = children.get(folder.parentId) ?? [];
        level.push(folder);
        children.set(folder.parentId, level);
    }
    const order = new Map<string, number>();
    const visit = (parentId: string | null) => {
        for (const folder of children.get(parentId) ?? []) {
            if (order.has(folder.id)) continue;
            order.set(folder.id, order.size);
            visit(folder.id);
        }
    };
    visit(null);
    result.sort(
        (a, b) => (order.get(a.folder.id) ?? 0) - (order.get(b.folder.id) ?? 0),
    );
    return matchFolderEntries(result, query, label);
}

export function folderActivity(
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    recordings: Recording[],
): Map<string, number> {
    const dates = new Map(
        recordings.map((item) => [item.id, Date.parse(item.startTime)]),
    );
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const result = new Map<string, number>();
    for (const assignment of assignments) {
        const date = dates.get(assignment.recordingId);
        if (date === undefined) continue;
        let folder = byId.get(assignment.folderId);
        const seen = new Set<string>();
        while (folder && !seen.has(folder.id)) {
            seen.add(folder.id);
            result.set(folder.id, Math.max(date, result.get(folder.id) ?? 0));
            folder = folder.parentId ? byId.get(folder.parentId) : undefined;
        }
    }
    return result;
}

export function visibleFolderLevel(
    level: readonly RecordingFolder[],
    activity: ReadonlyMap<string, number>,
    currentPath: ReadonlySet<string>,
    limit: number,
    showAll = false,
): RecordingFolder[] {
    const ordered = orderedFolders(level);
    if (showAll || level.length <= 10) return ordered;
    const active = [...ordered].sort(
        (a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0),
    );
    const chosen = new Set(
        ordered
            .filter((folder) => currentPath.has(folder.id))
            .map((folder) => folder.id),
    );
    for (const folder of active) {
        if (chosen.size >= limit) break;
        chosen.add(folder.id);
    }
    return ordered.filter((folder) => chosen.has(folder.id));
}

export function folderRowLocations(
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    folder: RecordingFolder | null,
): Map<string, RecordingFolder[]> {
    if (!folder) return new Map();
    const subtree = descendantFolderIds(folders, folder.id);
    const byId = new Map(folders.map((item) => [item.id, item]));
    const result = new Map<string, RecordingFolder[]>();
    for (const assignment of assignments) {
        const assigned = byId.get(assignment.folderId);
        if (!assigned || !subtree.has(assigned.id)) continue;
        result.set(assignment.recordingId, [
            ...(result.get(assignment.recordingId) ?? []),
            assigned,
        ]);
    }
    return result;
}
