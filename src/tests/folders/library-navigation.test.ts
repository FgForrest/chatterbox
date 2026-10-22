import { describe, expect, it } from "vitest";
import {
    effectiveRecordingCounts,
    recordingIdsVisibleInFolder,
} from "@/lib/folders/hierarchy";
import {
    folderActivity,
    folderRowLocations,
    matchFolderEntries,
    matchFolders,
    visibleFolderLevel,
} from "@/lib/folders/navigation";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "root",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const meetings: RecordingFolder = {
    ...root,
    id: "meetings",
    name: "Porády",
    parentId: root.id,
    kind: "custom",
};
const child: RecordingFolder = {
    ...meetings,
    id: "child",
    name: "Vývoj",
    parentId: meetings.id,
};
const folders = [root, meetings, child];

describe("folder matcher", () => {
    it("ranks name matches before path matches and ignores diacritics", () => {
        expect(
            matchFolders(folders, "porad").map((entry) => entry.folder.id),
        ).toEqual(["meetings", "child"]);
        expect(matchFolders(folders, "vyvoj")[0]?.path).toBe(
            "Private › Porády",
        );
    });
    it("matches a complete path while displaying only its ancestors", () => {
        const indexed = matchFolders(folders, "");
        for (const entries of [
            matchFolders(folders, "private › porady"),
            matchFolderEntries(
                indexed,
                "private › porady",
                (folder) => folder.name,
            ),
        ]) {
            expect(entries.map((entry) => entry.folder.id)).toEqual([
                "meetings",
                "child",
            ]);
            expect(entries[0].path).toBe("Private");
        }
    });
    it("returns all folders in hierarchical order for an empty query", () => {
        expect(
            matchFolders([child, root, meetings], "  ").map((entry) => [
                entry.folder.id,
                entry.depth,
            ]),
        ).toEqual([
            ["root", 0],
            ["meetings", 1],
            ["child", 2],
        ]);
    });
    it("matches localized roots while preserving custom names", () => {
        expect(
            matchFolders(folders, "soukrome", (folder) =>
                folder.kind === "private" ? "Soukromé" : folder.name,
            ),
        ).toHaveLength(3);
    });
});

describe("folder levels and recursive lists", () => {
    const level = Array.from(
        { length: 12 },
        (_, index): RecordingFolder => ({
            ...meetings,
            id: `f${index}`,
            name: `Folder ${index}`,
            sortOrder: index,
        }),
    );
    it.each([
        8, 6,
    ])("selects %i active folders in normal order and retains the current path", (limit) => {
        const activity = new Map(
            level.map((folder, index) => [folder.id, index]),
        );
        const visible = visibleFolderLevel(
            level,
            activity,
            new Set(["f0"]),
            limit,
        );
        expect(visible).toHaveLength(limit);
        expect(visible[0]?.id).toBe("f0");
        expect(visible.map((folder) => folder.sortOrder)).toEqual([
            0,
            ...Array.from(
                { length: limit - 1 },
                (_, index) => 13 - limit + index,
            ),
        ]);
        expect(
            visibleFolderLevel(level, activity, new Set(), limit, true),
        ).toHaveLength(12);
    });
    it("does not shorten a level with ten folders", () => {
        expect(
            visibleFolderLevel(level.slice(0, 10), new Map(), new Set(), 6),
        ).toHaveLength(10);
    });
    it("includes descendants once and labels their rows with their folder", () => {
        const assignments = [
            { folderId: meetings.id, recordingId: "direct" },
            { folderId: child.id, recordingId: "nested" },
        ];
        expect([
            ...recordingIdsVisibleInFolder(folders, assignments, meetings, []),
        ]).toEqual(["direct", "nested"]);
        expect(
            folderRowLocations(folders, assignments, meetings).get("nested"),
        ).toEqual([child]);
        const recording = {
            id: "nested",
            filename: "Invented meeting",
            startTime: "2026-10-21T10:00:00Z",
            duration: 1,
            filesize: 1,
            deviceSn: "local",
        };
        const activity = folderActivity(folders, assignments, [recording]);
        expect(activity.get(root.id)).toBe(Date.parse(recording.startTime));
        expect(activity.get(meetings.id)).toBe(activity.get(child.id));
    });
});

describe("recursive counts for the two navigation variants", () => {
    it("deduplicates multiple placements, excludes unavailable items and keeps Private ownership separate", () => {
        const org: RecordingFolder = {
            ...root,
            id: "org",
            name: "Organization",
            kind: "public",
            scope: "org",
        };
        const shared: RecordingFolder = {
            ...meetings,
            id: "shared",
            parentId: "org",
            scope: "org",
        };
        const allFolders = [...folders, org, shared];
        const counts = effectiveRecordingCounts(
            allFolders,
            [
                { recordingId: "own", folderId: meetings.id },
                { recordingId: "own", folderId: child.id },
                { recordingId: "own", folderId: "org" },
                { recordingId: "own", folderId: "shared" },
                { recordingId: "other", folderId: "shared" },
                { recordingId: "unavailable", folderId: "shared" },
            ],
            ["own", "other"],
            ["own"],
        );
        expect([...counts]).toEqual([
            ["root", 1],
            ["meetings", 1],
            ["child", 1],
            ["org", 2],
            ["shared", 2],
        ]);
    });
});
