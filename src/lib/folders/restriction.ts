import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { restrictedMemberCondition } from "@/db/queries/restricted-folders";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import {
    restrictedFolderAccessRequests,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import type { RecordingFolder } from "@/types/folder";

/** Restricted Organization folders are leaves, independently of person-shared folder rules. */
export function assertRestrictedFolderContainer(folder: {
    restrictedAt?: Date | null;
    restrictingAt?: Date | null;
}) {
    if (folder.restrictedAt || folder.restrictingAt)
        throw new AppError(
            ErrorCode.RESTRICTED_FOLDER_LEAF,
            ErrorCode.RESTRICTED_FOLDER_LEAF,
            409,
        );
}

/** Validate the same active non-Organization recipients used by person invitations. */
export async function validateRestrictedAudience(userIds: readonly string[]) {
    const ids = [...new Set(userIds)];
    if (
        userIds.length > 20 ||
        userIds.some((id) => typeof id !== "string" || !id)
    )
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    const rows = ids.length
        ? await db
              .select({ id: users.id })
              .from(users)
              .where(
                  and(inArray(users.id, ids), activeShareRecipientCondition()),
              )
        : [];
    if (rows.length !== ids.length)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    return ids;
}

/** Add the creator as manager and the chosen audience in the folder creation transaction. */
export async function initializeRestrictedAudienceInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    folderId: string,
    creator: string,
    userIds: readonly string[],
) {
    await tx
        .insert(restrictedFolderMembers)
        .values(
            [...new Set([creator, ...userIds])].map((userId) => ({
                folderId,
                userId,
                role:
                    userId === creator
                        ? ("manager" as const)
                        : ("member" as const),
                addedByUserId: creator,
            })),
        )
        .onConflictDoNothing();
}

/** Annotate visible restricted folders with the viewer's audience role. */
export async function restrictedFolderRoles(viewerUserId: string) {
    const rows = await db
        .select({
            folderId: restrictedFolderMembers.folderId,
            role: restrictedFolderMembers.role,
        })
        .from(restrictedFolderMembers)
        .where(
            and(
                eq(restrictedFolderMembers.userId, viewerUserId),
                restrictedMemberCondition(
                    viewerUserId,
                    restrictedFolderMembers.folderId,
                ),
            ),
        );
    return new Map(rows.map((row) => [row.folderId, row.role]));
}

/** Public tree nodes disclose managers' names and only the viewer's request state. */
export async function restrictedFolderNodes(
    folders: RecordingFolder[],
    viewer: { userId: string; isCurator: boolean },
): Promise<RecordingFolder[]> {
    const ids = folders
        .filter((folder) => folder.restricted)
        .map((folder) => folder.id);
    if (!ids.length) return folders;
    const [roles, managers, requests] = await Promise.all([
        restrictedFolderRoles(viewer.userId),
        db
            .select({
                folderId: restrictedFolderMembers.folderId,
                name: users.name,
            })
            .from(restrictedFolderMembers)
            .innerJoin(users, eq(users.id, restrictedFolderMembers.userId))
            .where(
                and(
                    inArray(restrictedFolderMembers.folderId, ids),
                    eq(restrictedFolderMembers.role, "manager"),
                    activeShareRecipientCondition(),
                ),
            ),
        db
            .select({
                folderId: restrictedFolderAccessRequests.folderId,
                state: restrictedFolderAccessRequests.state,
            })
            .from(restrictedFolderAccessRequests)
            .where(
                and(
                    eq(restrictedFolderAccessRequests.userId, viewer.userId),
                    inArray(restrictedFolderAccessRequests.folderId, ids),
                ),
            )
            .orderBy(
                desc(sql`${restrictedFolderAccessRequests.state} = 'pending'`),
                desc(
                    sql`coalesce(${restrictedFolderAccessRequests.decidedAt}, ${restrictedFolderAccessRequests.createdAt})`,
                ),
                desc(restrictedFolderAccessRequests.createdAt),
                desc(restrictedFolderAccessRequests.id),
            ),
    ]);
    return folders.map((folder) => {
        if (!folder.restricted) return folder;
        const role = viewer.isCurator
            ? ("curator" as const)
            : roles.get(folder.id);
        const state = requests.find(
            (request) => request.folderId === folder.id,
        )?.state;
        return {
            ...folder,
            access: !!role,
            ...(role ? { restrictedRole: role } : {}),
            managers: managers
                .filter((manager) => manager.folderId === folder.id)
                .map(({ name }) => ({ name })),
            accessRequest:
                state === "pending" || state === "declined" ? state : "none",
        };
    });
}
