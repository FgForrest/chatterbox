import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import type { ArchiveScope } from "@/lib/export/archive-scope";

/** Restricted tree metadata belongs to the Organization; withheld placements belong to their item owner. */
export async function collectRestrictedFolderArchive(scope: ArchiveScope) {
    let foldersMetadata: {
        id: string;
        restrictedAt: string | null;
        audience: {
            folderId: string;
            userId: string;
            email: string;
            role: "manager" | "member";
            addedByUserId: string | null;
            createdAt: string;
        }[];
    }[] = [];
    const ownerId = scope.kind === "personal" ? scope.userId : scope.orgUserId;
    if (scope.kind === "organization") {
        const folders = await db
            .select()
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, scope.orgUserId));
        const audience = await db
            .select({
                folderId: restrictedFolderMembers.folderId,
                userId: users.id,
                email: users.email,
                role: restrictedFolderMembers.role,
                addedByUserId: restrictedFolderMembers.addedByUserId,
                createdAt: restrictedFolderMembers.createdAt,
            })
            .from(restrictedFolderMembers)
            .innerJoin(users, eq(users.id, restrictedFolderMembers.userId))
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, restrictedFolderMembers.folderId),
            )
            .where(eq(recordingFolders.userId, scope.orgUserId));
        foldersMetadata = folders
            .filter(
                (folder) =>
                    folder.restrictedAt ||
                    folder.restrictingAt ||
                    audience.some((member) => member.folderId === folder.id),
            )
            .map((folder) => ({
                id: folder.id,
                restrictedAt:
                    (
                        folder.restrictedAt ?? folder.restrictingAt
                    )?.toISOString() ?? null,
                audience: audience
                    .filter((member) => member.folderId === folder.id)
                    .map((member) => ({
                        ...member,
                        createdAt: member.createdAt.toISOString(),
                    })),
            }));
    }
    const placements = await db
        .select({
            itemId: recordingFolderAssignments.itemId,
            folderId: recordingFolders.id,
            releasedAt: recordingFolderAssignments.releasedAt,
            withheld: recordingFolderAssignments.withheld,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .innerJoin(users, eq(users.id, recordingFolders.userId))
        .innerJoin(
            chatterItems,
            eq(chatterItems.id, recordingFolderAssignments.itemId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.userId, ownerId),
                eq(chatterItems.userId, ownerId),
                or(
                    isNull(chatterItems.deletedAt),
                    and(
                        eq(chatterItems.kind, "meeting"),
                        sql`exists (
                        select 1 from ${meetingAgendas} retained_agenda
                        inner join ${chatterItems} retained_recording on retained_recording.id = retained_agenda.recording_item_id
                        where retained_agenda.meeting_item_id = ${chatterItems.id}
                          and retained_agenda.user_id = ${ownerId}
                          and retained_recording.user_id = ${ownerId} and retained_recording.deleted_at is null
                    )`,
                    ),
                ),
                eq(users.role, "org"),
            ),
        );
    const tree = placements.length
        ? await db
              .select({
                  id: recordingFolders.id,
                  parentId: recordingFolders.parentId,
                  name: recordingFolders.name,
              })
              .from(recordingFolders)
              .innerJoin(users, eq(users.id, recordingFolders.userId))
              .where(eq(users.role, "org"))
        : [];
    const byId = new Map(tree.map((row) => [row.id, row]));
    return {
        folders: foldersMetadata,
        placements: placements.map((placement) => {
            const path: string[] = [];
            const seen = new Set<string>();
            let folder = byId.get(placement.folderId);
            while (folder && !seen.has(folder.id)) {
                seen.add(folder.id);
                path.unshift(decryptText(folder.name));
                folder = folder.parentId
                    ? byId.get(folder.parentId)
                    : undefined;
            }
            return {
                ...placement,
                path,
                releasedAt: placement.releasedAt?.toISOString() ?? null,
            };
        }),
    };
}
