import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { placementVisibleCondition } from "@/db/queries/restricted-folders";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertCategorizableFolders } from "@/lib/folders/folders";
import { getOrgUserId } from "@/lib/org/config";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";

/** Maximum number of folder ids accepted by one categorization request. */
export const MAX_CATEGORIZATION_FOLDERS = 100;

/** Validate an owner's categorization target and resolve its folder defaults. */
export async function resolveCategorizationSelection(input: {
    ownerUserId: string;
    itemId: string;
    folderIds: readonly string[];
    seedProfiles?: boolean;
}) {
    const [item] = await db
        .select({ id: chatterItems.id, kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, input.itemId),
                eq(chatterItems.userId, input.ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item || item.kind === "meeting")
        throw new AppError(ErrorCode.NOT_FOUND, "Item not found", 404);

    const requestedFolderIds = [...new Set(input.folderIds)];
    const orgUserId = await getOrgUserId();
    const viewer = {
        userId: input.ownerUserId,
        isCurator: await userCuratesOrganizationNow(input.ownerUserId),
    };
    const lockedPlacements = orgUserId
        ? await db
              .select({
                  folderId: recordingFolders.id,
                  ownerId: recordingFolders.userId,
              })
              .from(recordingFolderAssignments)
              .innerJoin(
                  recordingFolders,
                  eq(recordingFolders.id, recordingFolderAssignments.folderId),
              )
              .where(
                  and(
                      eq(recordingFolderAssignments.itemId, input.itemId),
                      eq(recordingFolderAssignments.userId, input.ownerUserId),
                      eq(recordingFolderAssignments.withheld, true),
                      isNotNull(recordingFolders.restrictedAt),
                      eq(recordingFolders.userId, orgUserId),
                      sql`not (${placementVisibleCondition(viewer)})`,
                  ),
              )
        : [];
    const retained = lockedPlacements.filter((placement) =>
        requestedFolderIds.includes(placement.folderId),
    );
    const retainedFolderIds = retained.map((placement) => placement.folderId);
    const writableFolders = await assertCategorizableFolders(
        input.ownerUserId,
        requestedFolderIds.filter((id) => !retainedFolderIds.includes(id)),
    );
    const folders = [
        ...writableFolders,
        ...retained.map((placement) => ({
            ...placement,
            scope: "org" as const,
        })),
    ];
    const folderIds = [...new Set(folders.map((folder) => folder.folderId))];
    const resolution = await resolveProfileForPlacements({
        ownerUserId: input.ownerUserId,
        itemId: input.itemId,
        channel: item.kind,
        folderIds: writableFolders.map((folder) => folder.folderId),
        view: "private",
        seedProfiles: input.seedProfiles,
    });
    return {
        item: { ...item, kind: item.kind },
        folderIds,
        folders,
        retainedFolderIds,
        resolution,
    };
}
