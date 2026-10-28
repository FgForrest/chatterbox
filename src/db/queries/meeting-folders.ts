import { and, asc, desc, eq } from "drizzle-orm";
import type { MeetingExecutor } from "@/db/queries/meetings";
import { recordingFolderAssignments, recordingFolders } from "@/db/schema";

/** The meeting's actual filing, retained on its tombstone after absorption. */
export async function meetingFolders(
    executor: MeetingExecutor,
    meetingItemId: string,
    ownerUserId: string,
) {
    return executor
        .select({
            id: recordingFolders.id,
            name: recordingFolders.name,
            userId: recordingFolders.userId,
            parentId: recordingFolders.parentId,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, meetingItemId),
                eq(recordingFolderAssignments.userId, ownerUserId),
            ),
        )
        .orderBy(
            desc(recordingFolderAssignments.createdAt),
            asc(recordingFolders.id),
        );
}
