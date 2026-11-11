import { and, eq, or } from "drizzle-orm";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { restrictedFolderVisibleCondition } from "@/db/queries/restricted-folders";
import { recordingFolders } from "@/db/schema";

/** Folder metadata follows ownership, Organization scope and live direct invitations. */
export function meetingFolderVisibility(
    userId: string,
    orgUserId: string | null,
    isCurator = false,
) {
    return and(
        restrictedFolderVisibleCondition({ userId, isCurator }),
        or(
            eq(recordingFolders.userId, userId),
            orgUserId ? eq(recordingFolders.userId, orgUserId) : undefined,
            and(
                eq(recordingFolders.kind, "custom"),
                folderParticipantCondition(
                    recordingFolders.userId,
                    userId,
                    recordingFolders.id,
                ),
            ),
        ),
    );
}
