import {
    type AnyColumn,
    and,
    eq,
    inArray,
    isNull,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import { activeShareRecipientExistsCondition } from "@/db/queries/share-recipients";
import {
    chatterItems,
    folderExportConfigurations,
    folderExportMaterializations,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
} from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";

export interface RestrictedViewer {
    userId: string;
    isCurator: boolean;
}

/** Live audience membership, retained for withheld placements after a lift. */
export function restrictedMemberCondition(
    userId: string | AnyColumn,
    folderId: AnyColumn | SQL | string = recordingFolders.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`exists (select 1 from ${restrictedFolderMembers} restricted_member
        where restricted_member.folder_id = ${folderId} and restricted_member.user_id = ${userId}
        and ${activeShareRecipientExistsCondition(userId)})`;
}

/** Private folder details remain audience-only; public tree nodes use a separate projection. */
export function restrictedFolderVisibleCondition(viewer: RestrictedViewer) {
    return viewer.isCurator
        ? sql`true`
        : or(
              isNull(recordingFolders.restrictedAt),
              restrictedMemberCondition(viewer.userId),
          );
}

/** A withheld placement discloses its folder only to its audience and current curators. */
export function placementVisibleCondition(viewer: RestrictedViewer) {
    return viewer.isCurator
        ? sql`true`
        : and(
              restrictedFolderVisibleCondition(viewer),
              or(
                  eq(recordingFolderAssignments.withheld, false),
                  restrictedMemberCondition(viewer.userId),
              ),
          );
}

/** Item state used to protect secondary discovery channels that otherwise bypass read access. */
export function withheldItemCondition(itemId: AnyColumn = chatterItems.id) {
    return sql`exists (select 1 from ${recordingFolderAssignments}
        where ${recordingFolderAssignments.itemId} = ${itemId}
        and ${recordingFolderAssignments.withheld})`;
}

/** Read-only access to items withheld from the Organization; independent of other placements. */
export function restrictedItemCondition(
    viewer: RestrictedViewer,
    itemId: AnyColumn = chatterItems.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`exists (select 1 from ${recordingFolderAssignments}
        inner join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${itemId}
        and exists (select 1 from chatter_items restricted_item_owner where restricted_item_owner.id = ${itemId} and restricted_item_owner.user_id <> ${viewer.userId})
        and (${recordingFolderAssignments.withheld} or ${recordingFolders.restrictedAt} is not null)
        and ${viewer.isCurator ? sql`true` : restrictedMemberCondition(viewer.userId)})`;
}

/** Whether the caller has the restricted audience's receiver access. */
export async function isRestrictedItemReceived(
    viewer: RestrictedViewer,
    itemId: string,
) {
    const [row] = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                isNull(chatterItems.deletedAt),
                restrictedItemCondition(viewer),
            ),
        )
        .limit(1);
    return !!row;
}

/** Content-free invalidations for the restricted audience, never the Organization broadcast. */
export async function notifyRestrictedAudienceInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    folderId: string | readonly string[],
) {
    const ids = typeof folderId === "string" ? [folderId] : [...folderId];
    if (!ids.length) return;
    await tx.execute(sql`select pg_notify(${"riffado_personal"}, json_build_object('type', 'share', 'userId', ${restrictedFolderMembers.userId})::text)
        from ${restrictedFolderMembers} where ${inArray(restrictedFolderMembers.folderId, ids)} and ${activeShareRecipientExistsCondition(restrictedFolderMembers.userId)}`);
}

/** Clear former audience rows only once every placement in an open folder is released. */
export async function dropReleasedAudienceInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    folderId: string,
) {
    await tx
        .delete(restrictedFolderMembers)
        .where(
            and(
                eq(restrictedFolderMembers.folderId, folderId),
                sql`exists (select 1 from ${recordingFolders} where ${recordingFolders.id} = ${folderId} and ${recordingFolders.restrictedAt} is null)`,
                sql`not exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.folderId} = ${folderId} and ${recordingFolderAssignments.withheld})`,
            ),
        );
}

/** Carry an item's existing release grace across additional open placements and moves. */
export async function placementReleaseTimeInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ownerUserId: string,
    itemId: string,
    orgUserId: string,
) {
    const rows = await tx
        .select({
            withheld: recordingFolderAssignments.withheld,
            releasedAt: recordingFolderAssignments.releasedAt,
            restrictedAt: recordingFolders.restrictedAt,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, itemId),
                eq(recordingFolderAssignments.userId, ownerUserId),
                eq(recordingFolders.userId, orgUserId),
            ),
        );
    const released = rows.filter((row) => !row.withheld && !row.restrictedAt);
    if (released.some((row) => !row.releasedAt)) return null;
    if (released.length)
        return new Date(
            Math.min(
                ...released.flatMap((row) =>
                    row.releasedAt ? [row.releasedAt.getTime()] : [],
                ),
            ),
        );
    return rows.some((row) => row.withheld || row.restrictedAt)
        ? new Date()
        : null;
}

/** New audience membership and new direct filing make existing assigned tasks new to a receiver. */
export function restrictedItemSinceCondition(
    userId: string,
    seen: Date,
    itemId: AnyColumn = chatterItems.id,
) {
    return sql`exists (select 1 from ${recordingFolderAssignments} inner join ${restrictedFolderMembers} on ${restrictedFolderMembers.folderId} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${itemId} and ${recordingFolderAssignments.withheld}
        and ${restrictedFolderMembers.userId} = ${userId}
        and ${activeShareRecipientExistsCondition(userId)}
        and (${restrictedFolderMembers.createdAt} > ${seen.toISOString()}::timestamp or ${recordingFolderAssignments.createdAt} > ${seen.toISOString()}::timestamp))`;
}

/** Withheld placements whose previously exported copies must be revoked. */
export async function withheldExportPlacements(
    orgUserId: string,
    itemIds: string[],
) {
    if (!itemIds.length) return [];
    return db
        .select({
            itemId: recordingFolderAssignments.itemId,
            folderId: recordingFolderAssignments.folderId,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolders.userId, orgUserId),
                inArray(recordingFolderAssignments.itemId, itemIds),
                or(
                    eq(recordingFolderAssignments.withheld, true),
                    sql`${recordingFolders.restrictedAt} is not null`,
                ),
            ),
        );
}

/** Persist removal authority independently of placement lifecycle; a null item marks the whole folder. */
export async function revokePlacementExportsInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    orgUserId: string,
    itemId: string | null,
    folderId: string,
) {
    await tx
        .update(folderExportMaterializations)
        .set({ revocationPending: true })
        .where(
            and(
                itemId
                    ? eq(folderExportMaterializations.itemId, itemId)
                    : undefined,
                eq(folderExportMaterializations.placementFolderId, folderId),
                sql`exists (select 1 from ${folderExportConfigurations}
                inner join ${recordingFolders} export_root on export_root.id = ${folderExportConfigurations.folderId}
                where ${folderExportConfigurations.id} = ${folderExportMaterializations.exportConfigurationId}
                and ${folderExportConfigurations.userId} = ${folderExportMaterializations.userId}
                and export_root.user_id = ${orgUserId})`,
            ),
        );
}
