import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { folderShares, recordingFolders, users } from "@/db/schema";
import type { ArchiveScope } from "@/lib/export/archive-scope";

/** Owner-only folder invitation metadata; receiver names and attachments never enter an archive. */
export async function collectArchivedFolderShares(scope: ArchiveScope) {
    if (scope.kind !== "personal") return [];
    const rows = await db
        .select({
            folderId: folderShares.folderId,
            receiverEmail: users.email,
            state: folderShares.state,
            invitedAt: folderShares.invitedAt,
            respondedAt: folderShares.respondedAt,
            removedAt: folderShares.removedAt,
        })
        .from(folderShares)
        .innerJoin(
            recordingFolders,
            and(
                eq(recordingFolders.id, folderShares.folderId),
                eq(recordingFolders.userId, scope.userId),
            ),
        )
        .innerJoin(users, eq(users.id, folderShares.receiverUserId))
        .where(eq(folderShares.userId, scope.userId));
    return rows.map((row) => ({
        ...row,
        invitedAt: row.invitedAt.toISOString(),
        respondedAt: row.respondedAt?.toISOString() ?? null,
        removedAt: row.removedAt?.toISOString() ?? null,
    }));
}
