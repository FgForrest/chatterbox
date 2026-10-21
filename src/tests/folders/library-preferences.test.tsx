// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLibraryPreferencesState } from "@/hooks/use-library-preferences";
import type { RecordingFolder } from "@/types/folder";

const folders: RecordingFolder[] = Array.from({ length: 7 }, (_, index) => ({
    id: `f${index}`,
    name: `Folder ${index}`,
    parentId: "private",
    kind: "custom",
    scope: "personal",
    sortOrder: index,
    version: 0,
}));
const items = [
    {
        id: "item",
        filename: "Meeting",
        duration: 1,
        filesize: 1,
        deviceSn: "local",
        startTime: "2026-10-21T10:00:00Z",
    },
];
const assignments = [{ recordingId: "item", folderId: "f3" }];
function usePreferences(userId: string) {
    return useLibraryPreferencesState(userId, folders, assignments, items);
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
});

describe("library browser preferences", () => {
    it("keeps the context value stable when its inputs and preferences do not change", () => {
        const { result, rerender } = renderHook(() =>
            usePreferences("viewer-a"),
        );
        const previous = result.current;
        rerender();
        expect(result.current).toBe(previous);
        act(() => result.current.rememberFolder("f1"));
        expect(result.current).not.toBe(previous);
    });
    it("falls back to folders of newest items, then records five opened or filed folders", () => {
        const { result } = renderHook(() => usePreferences("viewer-a"));
        expect(result.current.recentFolders.map((folder) => folder.id)).toEqual(
            ["f3"],
        );
        act(() => {
            for (const folder of folders)
                result.current.rememberFolder(folder.id);
        });
        expect(result.current.recentFolders.map((folder) => folder.id)).toEqual(
            ["f6", "f5", "f4", "f3", "f2"],
        );
    });
    it("never remembers roots and ignores assignments of other people's items in the fallback", () => {
        const root = {
            ...folders[0],
            id: "private",
            kind: "private" as const,
            parentId: null,
        };
        const { result } = renderHook(() =>
            useLibraryPreferencesState(
                "viewer",
                [root, ...folders],
                [
                    ...assignments,
                    { recordingId: "another-item", folderId: "f4" },
                ],
                items,
            ),
        );
        act(() => result.current.rememberFolder("private"));
        expect(result.current.preferences.recent).toEqual([]);
        expect(result.current.recentFolders.map((folder) => folder.id)).toEqual(
            ["f3"],
        );
    });
    it("remembers expansion and rail collapse per user", () => {
        const first = renderHook(() => usePreferences("viewer-a"));
        act(() =>
            first.result.current.setPreferences((value) => ({
                ...value,
                expanded: ["private", "f1"],
                collapsed: true,
            })),
        );
        first.unmount();
        const second = renderHook(() => usePreferences("viewer-a"));
        expect(second.result.current.preferences.expanded).toEqual([
            "private",
            "f1",
        ]);
        expect(second.result.current.preferences.collapsed).toBe(true);
        const other = renderHook(() => usePreferences("viewer-b"));
        expect(other.result.current.preferences.collapsed).toBe(false);
        expect(other.result.current.preferences.expanded).toBeNull();
    });
    it("renders and remembers within the session when storage throws", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("unavailable");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("unavailable");
        });
        const { result } = renderHook(() => usePreferences("viewer-a"));
        act(() => result.current.rememberFolder("f1"));
        expect(result.current.recentFolders.map((folder) => folder.id)).toEqual(
            ["f1"],
        );
    });
});
