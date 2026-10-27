import type { MeetingRowData } from "@/components/meetings/types";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import type { RecordingFolder } from "@/types/folder";

/** Match the personal/received Recent pool or the selected folder's subtree. */
export function meetingsInLocation(
    meetings: readonly MeetingRowData[],
    folders: readonly RecordingFolder[],
    selectedFolder: RecordingFolder | null,
    userId: string | undefined,
    isOrgAccount: boolean,
) {
    const descendants = selectedFolder
        ? descendantFolderIds(folders, selectedFolder.id)
        : null;
    const participantFolders = new Set(
        folders
            .filter(
                (folder) =>
                    folder.scope === "personal" &&
                    (folder.receivedFolder || folder.sharedWithPeople),
            )
            .map((folder) => folder.id),
    );
    return meetings.filter((meeting) =>
        descendants
            ? meeting.folders.some((folder) => descendants.has(folder.id))
            : isOrgAccount ||
              meeting.author.id === userId ||
              meeting.folders.some((folder) =>
                  participantFolders.has(folder.id),
              ),
    );
}
