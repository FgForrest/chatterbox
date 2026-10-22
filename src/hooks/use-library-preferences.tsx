"use client";

import type { Dispatch, SetStateAction } from "react";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { folderActivity } from "@/lib/folders/navigation";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

interface Preferences {
    expanded: string[] | null;
    recent: string[];
    collapsed: boolean;
}
interface LibraryPreferences {
    ready: boolean;
    preferences: Preferences;
    setPreferences: Dispatch<SetStateAction<Preferences>>;
    recentFolders: RecordingFolder[];
    rememberFolder: (id: string) => void;
}
const defaults: Preferences = { expanded: null, recent: [], collapsed: false };
const fallback: LibraryPreferences = {
    ready: true,
    preferences: defaults,
    setPreferences: () => {},
    recentFolders: [],
    rememberFolder: () => {},
};
export const LibraryPreferencesContext =
    createContext<LibraryPreferences>(fallback);

function stringsOnly(values: unknown[]): string[] {
    return values.filter((id): id is string => typeof id === "string");
}

export function useLibraryPreferences() {
    return useContext(LibraryPreferencesContext);
}

export function useLibraryPreferencesState(
    userId: string | undefined,
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    recordings: Recording[],
): LibraryPreferences {
    const key = userId ? `klepna:library:${userId}` : null;
    const [state, setState] = useState<{
        key: string | null;
        value: Preferences;
    }>({ key: null, value: defaults });
    const preferences = state.key === key ? state.value : defaults;
    useEffect(() => {
        let value = defaults;
        try {
            const raw: unknown = key
                ? JSON.parse(localStorage.getItem(key) ?? "null")
                : null;
            if (raw && typeof raw === "object") {
                const saved = raw as Partial<Preferences>;
                value = {
                    expanded: Array.isArray(saved.expanded)
                        ? stringsOnly(saved.expanded)
                        : null,
                    recent: Array.isArray(saved.recent)
                        ? stringsOnly(saved.recent).slice(0, 5)
                        : [],
                    collapsed: saved.collapsed === true,
                };
            }
        } catch {}
        setState({ key, value });
    }, [key]);
    useEffect(() => {
        if (state.key !== key) return;
        const ids = new Set(folders.map((folder) => folder.id));
        const expanded =
            state.value.expanded?.filter((id) => ids.has(id)) ?? null;
        const recent = state.value.recent.filter((id) => ids.has(id));
        if (
            expanded?.length !== state.value.expanded?.length ||
            recent.length !== state.value.recent.length
        ) {
            setState((current) => ({
                ...current,
                value: { ...current.value, expanded, recent },
            }));
            return;
        }
        try {
            if (key) localStorage.setItem(key, JSON.stringify(state.value));
        } catch {}
    }, [key, state, folders]);
    const setPreferences = useCallback<Dispatch<SetStateAction<Preferences>>>(
        (update) => {
            setState((current) => {
                const previous = current.key === key ? current.value : defaults;
                const value =
                    typeof update === "function" ? update(previous) : update;
                return { key, value };
            });
        },
        [key],
    );
    const rememberFolder = useCallback(
        (id: string) => {
            if (
                !folders.some(
                    (folder) => folder.id === id && folder.kind === "custom",
                )
            )
                return;
            setPreferences((value) => ({
                ...value,
                recent: [
                    id,
                    ...value.recent.filter((item) => item !== id),
                ].slice(0, 5),
            }));
        },
        [folders, setPreferences],
    );
    const recentFolders = useMemo(() => {
        const saved = preferences.recent.flatMap(
            (id) =>
                folders.find(
                    (folder) => folder.id === id && folder.kind === "custom",
                ) ?? [],
        );
        if (saved.length > 0) return saved;
        const activity = folderActivity(folders, assignments, recordings);
        const assignedIds = new Set(
            assignments.map((assignment) => assignment.folderId),
        );
        return folders
            .filter(
                (folder) =>
                    folder.kind === "custom" &&
                    assignedIds.has(folder.id) &&
                    activity.has(folder.id),
            )
            .sort(
                (a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0),
            )
            .slice(0, 5);
    }, [preferences.recent, folders, assignments, recordings]);
    return useMemo(
        () => ({
            ready: state.key === key,
            preferences,
            setPreferences,
            recentFolders,
            rememberFolder,
        }),
        [
            state.key,
            key,
            preferences,
            setPreferences,
            recentFolders,
            rememberFolder,
        ],
    );
}
