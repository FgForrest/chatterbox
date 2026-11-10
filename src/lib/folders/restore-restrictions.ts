import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { restrictedMemberCondition } from "@/db/queries/restricted-folders";
import {
    chatterItems,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    lockItemForFolderMutation,
    lockOrgTree,
    shareItemToOrganizationFolderInTx,
} from "@/lib/folders/folders";
import { assertOrgScopeWritable, getOrgUserId } from "@/lib/org/config";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";

export const withheldPlacementArchiveSchema = z.object({
    itemId: z.string(),
    folderId: z.string(),
    withheld: z.boolean().default(true),
    path: z.array(z.string()),
    releasedAt: z.iso.datetime().nullable(),
});

/** Restore the caller's Organization placements, preserving release grace and current folder access. */
export async function restoreWithheldPlacements(
    userId: string,
    entries: z.infer<typeof withheldPlacementArchiveSchema>[],
    itemIdMap: Record<string, string>,
) {
    const orgUserId = await getOrgUserId();
    const organizationOwner =
        userId === orgUserId && (await userCuratesOrganizationNow(userId));
    let restored = 0;
    let skipped = 0;
    for (const entry of entries) {
        const itemId = itemIdMap[entry.itemId];
        if (!itemId) {
            skipped++;
            continue;
        }
        const filed = await db.transaction(async (tx) => {
            await lockOrgTree(tx);
            const [folder] = await tx
                .select({
                    id: recordingFolders.id,
                    restrictedAt: recordingFolders.restrictedAt,
                    restrictingAt: recordingFolders.restrictingAt,
                })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.id, entry.folderId),
                        orgUserId
                            ? eq(recordingFolders.userId, orgUserId)
                            : sql`false`,
                        organizationOwner
                            ? sql`true`
                            : entry.withheld
                              ? or(
                                    and(
                                        isNull(recordingFolders.restrictedAt),
                                        isNull(recordingFolders.restrictingAt),
                                    ),
                                    restrictedMemberCondition(userId),
                                )
                              : sql`true`,
                    ),
                )
                .for("share");
            const [item] = await tx
                .select({ id: chatterItems.id })
                .from(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, itemId),
                        eq(chatterItems.userId, userId),
                    ),
                );
            if (!folder || !item) return false;
            const [existing] = await tx
                .select({ id: recordingFolderAssignments.itemId })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, itemId),
                        eq(recordingFolderAssignments.userId, userId),
                        eq(recordingFolderAssignments.folderId, folder.id),
                    ),
                );
            if (existing) return true;
            if (
                entry.withheld &&
                !folder.restrictedAt &&
                !folder.restrictingAt
            ) {
                await lockItemForFolderMutation(tx, itemId, userId);
                await tx
                    .insert(mailPendingShares)
                    .values({
                        userId,
                        itemId,
                        folderId: folder.id,
                        confirmedAt: new Date(),
                    })
                    .onConflictDoNothing();
                await requestAdvanceInTx(tx, {
                    userId,
                    itemId,
                    view: "private",
                    reason: "placement",
                });
                return true;
            }
            if (!entry.withheld && orgUserId) {
                const problems = await shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId: userId,
                    itemId,
                    folderId: folder.id,
                    orgUserId,
                });
                if (problems.length) return false;
                await tx
                    .update(recordingFolderAssignments)
                    .set({
                        releasedAt: entry.releasedAt
                            ? new Date(entry.releasedAt)
                            : null,
                    })
                    .where(
                        and(
                            eq(recordingFolderAssignments.itemId, itemId),
                            eq(recordingFolderAssignments.userId, userId),
                            eq(recordingFolderAssignments.folderId, folder.id),
                        ),
                    );
                return true;
            }
            await lockItemForFolderMutation(tx, itemId, userId);
            await tx
                .insert(recordingFolderAssignments)
                .values({
                    userId,
                    itemId,
                    folderId: folder.id,
                    withheld: true,
                    releasedAt: entry.releasedAt
                        ? new Date(entry.releasedAt)
                        : null,
                })
                .onConflictDoNothing();
            return true;
        });
        if (filed) restored++;
        else skipped++;
    }
    return { restored, skipped };
}

export const restrictedFolderArchiveSchema = z.object({
    id: z.string(),
    restrictedAt: z.iso.datetime().nullable(),
    audience: z
        .array(
            z.object({
                userId: z.string(),
                email: z.email(),
                role: z.enum(["manager", "member"]),
                addedByUserId: z.string().nullable(),
                createdAt: z.iso.datetime(),
            }),
        )
        .max(10000),
});

/** Restore Organization restriction metadata on empty restored folders, resolving audience identities by email. */
export async function restoreRestrictedFolderMetadata(
    userId: string,
    entries: z.infer<typeof restrictedFolderArchiveSchema>[],
    folderIds: Record<string, string>,
) {
    if (!(await userCuratesOrganizationNow(userId)))
        throw new AppError(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN, 403);
    assertOrgScopeWritable();
    const orgId = await getOrgUserId();
    if (!orgId)
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    return db.transaction(async (tx) => {
        await lockOrgTree(tx);
        let restored = 0;
        for (const entry of entries) {
            const folderId = folderIds[entry.id];
            if (!folderId) continue;
            const [folder] = await tx
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.id, folderId),
                        eq(recordingFolders.userId, orgId),
                        eq(recordingFolders.kind, "custom"),
                    ),
                )
                .for("update");
            if (!folder)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    ErrorCode.NOT_FOUND,
                    404,
                );
            const [occupied] = await tx
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.id, folderId),
                        sql`(exists (select 1 from ${recordingFolders} child where child.parent_id = ${folderId}) or exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.folderId} = ${folderId}))`,
                    ),
                );
            if (occupied)
                throw new AppError(ErrorCode.CONFLICT, ErrorCode.CONFLICT, 409);
            await tx
                .update(recordingFolders)
                .set({
                    restrictedAt: entry.restrictedAt
                        ? new Date(entry.restrictedAt)
                        : null,
                    restrictingAt: null,
                })
                .where(eq(recordingFolders.id, folderId));
            await tx
                .delete(restrictedFolderMembers)
                .where(eq(restrictedFolderMembers.folderId, folderId));
            for (const member of entry.restrictedAt ? entry.audience : []) {
                const [recipient] = await tx
                    .select({ id: users.id })
                    .from(users)
                    .where(
                        and(
                            sql`lower(${users.email}) = ${member.email.toLowerCase()}`,
                            sql`${users.role} in ('user', 'org')`,
                        ),
                    );
                if (recipient)
                    await tx
                        .insert(restrictedFolderMembers)
                        .values({
                            folderId,
                            userId: recipient.id,
                            role: member.role,
                            addedByUserId: userId,
                            createdAt: new Date(member.createdAt),
                        })
                        .onConflictDoNothing();
            }
            restored++;
        }
        return { restored };
    });
}
