import { describe, expect, it } from "vitest";
import { meetingsInLocation } from "@/components/dashboard/meeting-location";
import { row } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";

const folders: RecordingFolder[] = [
    {
        id: "private",
        parentId: null,
        name: "Private",
        scope: "personal",
        kind: "private",
        sortOrder: 0,
        version: 0,
    },
    {
        id: "owned",
        parentId: "private",
        name: "Acme",
        scope: "personal",
        kind: "custom",
        sortOrder: 0,
        version: 0,
        sharedWithPeople: true,
    },
    {
        id: "received",
        parentId: "private",
        name: "Shared",
        scope: "personal",
        kind: "custom",
        sortOrder: 0,
        version: 0,
        receivedFolder: {
            sourceFolderId: "source",
            shareId: "share",
            shareVersion: 0,
            ownerName: "Jitka",
            originalName: "Acme",
        },
    },
    {
        id: "org",
        parentId: null,
        name: "Organization",
        scope: "org",
        kind: "public",
        sortOrder: 0,
        version: 0,
    },
    {
        id: "org-child",
        parentId: "org",
        name: "Team",
        scope: "org",
        kind: "custom",
        sortOrder: 0,
        version: 0,
    },
];
const meetings = [
    row({ id: "own" }),
    ...["owned", "received", "org-child"].map((folderId) =>
        row({
            id: folderId,
            author: { id: "colleague", name: "Jitka" },
            folders: [
                {
                    id: folderId,
                    userId: folderId === "owned" ? "owner" : "colleague",
                    parentId: "private",
                    name: "Acme",
                },
            ],
        }),
    ),
];
describe("Workstation meeting location", () => {
    it("Recent includes own meetings and both directions of person-shared contributions, excluding colleagues' Organization meetings", () => {
        expect(
            meetingsInLocation(meetings, folders, null, "owner", false).map(
                (meeting) => meeting.id,
            ),
        ).toEqual(["own", "owned", "received"]);
    });
    it("uses the selected folder and its descendants", () => {
        expect(
            meetingsInLocation(
                meetings,
                folders,
                folders[3],
                "owner",
                false,
            ).map((meeting) => meeting.id),
        ).toEqual(["org-child"]);
        expect(
            meetingsInLocation(
                meetings,
                folders,
                folders[0],
                "owner",
                false,
            ).map((meeting) => meeting.id),
        ).toEqual(["owned", "received"]);
    });
    it("uses the server-scoped Organization pool for the Organization account's Recent", () => {
        expect(
            meetingsInLocation(
                meetings.slice(3),
                folders,
                null,
                "org",
                true,
            ).map((meeting) => meeting.id),
        ).toEqual(["org-child"]);
    });
});
