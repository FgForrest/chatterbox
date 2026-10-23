import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    activeShareRecipientCondition,
    activeShareRecipientExistsCondition,
} from "@/db/queries/item-shares";
import {
    chatterItems,
    folderShares,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { notifyPersonShareChanged } from "@/lib/events/personal";
import { secretAddressMasker } from "@/lib/mail/redact";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";
import { isOrgScopeVisible } from "@/lib/org/config";
import { requirePersonSharing } from "@/lib/sharing/person-shares";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function missing() {
    return new AppError(ErrorCode.NOT_FOUND, "Share not found", 404);
}
function conflict() {
    return new AppError(
        ErrorCode.CONFLICT,
        "The invitation has changed. Refresh and try again.",
        409,
    );
}
function nameOf(value: string) {
    const name = value.trim().replace(/\s+/g, " ");
    if (!name || name.length > 100)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose a folder name of at most 100 characters",
            400,
        );
    return name;
}

async function ownedFolder(
    executor: Pick<typeof db, "select">,
    userId: string,
    folderId: string,
) {
    const [folder] = await executor
        .select()
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, folderId),
                eq(recordingFolders.userId, userId),
                eq(recordingFolders.kind, "custom"),
            ),
        )
        .for("update");
    if (!folder) throw missing();
    return folder;
}

/** The owner's folder invitations, without any receiver placement or name. */
export async function listFolderShares(userId: string, folderId: string) {
    await requirePersonSharing(userId);
    await ownedFolder(db, userId, folderId);
    return db
        .select({
            id: folderShares.id,
            receiverUserId: folderShares.receiverUserId,
            name: users.name,
            email: users.email,
            state: folderShares.state,
            version: folderShares.version,
            invitedAt: folderShares.invitedAt,
            respondedAt: folderShares.respondedAt,
        })
        .from(folderShares)
        .innerJoin(users, eq(users.id, folderShares.receiverUserId))
        .where(
            and(
                eq(folderShares.userId, userId),
                eq(folderShares.folderId, folderId),
            ),
        )
        .orderBy(asc(folderShares.createdAt));
}

/** Invite only active colleagues to a private folder, sharing its live direct contents. */
export async function inviteToFolder(
    userId: string,
    folderId: string,
    receiverIds: string[],
) {
    await requirePersonSharing(userId);
    const ids = [...new Set(receiverIds)];
    if (!ids.length || ids.length > 20 || ids.includes(userId))
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose between one and twenty colleagues",
            400,
        );
    const invited: string[] = [];
    await db.transaction(async (tx) => {
        await ownedFolder(tx, userId, folderId);
        const receivers = await tx
            .select({ id: users.id })
            .from(users)
            .where(
                and(
                    inArray(users.id, ids),
                    ne(users.id, userId),
                    activeShareRecipientCondition(),
                ),
            );
        if (receivers.length !== ids.length) throw missing();
        for (const receiverUserId of ids) {
            const [existing] = await tx
                .select()
                .from(folderShares)
                .where(
                    and(
                        eq(folderShares.userId, userId),
                        eq(folderShares.folderId, folderId),
                        eq(folderShares.receiverUserId, receiverUserId),
                    ),
                )
                .for("update");
            if (existing?.state === "pending" || existing?.state === "accepted")
                continue;
            if (existing) {
                await tx
                    .update(folderShares)
                    .set({
                        state: "pending",
                        version: existing.version + 1,
                        invitedAt: new Date(),
                        respondedAt: null,
                        removedAt: null,
                        updatedAt: new Date(),
                        invitedByUserId: userId,
                    })
                    .where(
                        and(
                            eq(folderShares.id, existing.id),
                            eq(folderShares.userId, userId),
                        ),
                    );
            } else {
                await tx.insert(folderShares).values({
                    userId,
                    receiverUserId,
                    folderId,
                    invitedByUserId: userId,
                });
            }
            invited.push(receiverUserId);
        }
    });
    await announceFolderInvitations(invited);
    return listFolderShares(userId, folderId);
}

/** Deliver the same content-free event and opt-in email as direct invitations. */
export async function announceFolderInvitations(receiverIds: Iterable<string>) {
    const ids = [...new Set(receiverIds)];
    await Promise.all(ids.map(notifyPersonShareChanged));
    for (const id of ids)
        void sendPersonShareInvitation(id).catch(() => {
            console.error("[folder-shares] invitation email failed");
        });
}

/** Pending folder invitations reveal only the explicitly shared folder's name. */
export async function listMyFolderInvitations(userId: string) {
    await requirePersonSharing(userId);
    const rows = await db
        .select({
            id: folderShares.id,
            itemId: folderShares.folderId,
            title: recordingFolders.name,
            ownerName: users.name,
            ownerEmail: users.email,
            invitedAt: folderShares.invitedAt,
            version: folderShares.version,
        })
        .from(folderShares)
        .innerJoin(
            recordingFolders,
            and(
                eq(recordingFolders.id, folderShares.folderId),
                eq(recordingFolders.userId, folderShares.userId),
            ),
        )
        .innerJoin(users, eq(users.id, folderShares.userId))
        .where(
            and(
                eq(folderShares.receiverUserId, userId),
                eq(folderShares.state, "pending"),
                activeShareRecipientExistsCondition(userId),
            ),
        )
        .orderBy(asc(folderShares.invitedAt));
    const mask = await secretAddressMasker(
        rows.map((row) => decryptText(row.title)),
    );
    return rows.map((row) => ({
        ...row,
        kind: "folder" as const,
        title: mask(decryptText(row.title)),
        ownerName: row.ownerName || row.ownerEmail,
    }));
}

async function attachmentParent(
    tx: Tx,
    userId: string,
    parentId: string | null | undefined,
) {
    if (parentId == null) return null;
    const [parent] = await tx
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, parentId),
                eq(recordingFolders.userId, userId),
                ne(recordingFolders.kind, "public"),
            ),
        )
        .for("share");
    if (!parent) throw missing();
    return parent.id;
}

/** Versioned folder invitation responses and receiver-only attachment edits. */
export async function changeFolderShare(
    userId: string,
    shareId: string,
    input: {
        action: "accept" | "decline" | "cancel" | "remove" | "rename" | "move";
        version: number;
        name?: string;
        parentId?: string | null;
        sortOrder?: number;
    },
) {
    await requirePersonSharing(userId);
    const changed = await db.transaction(async (tx) => {
        const condition = and(
            eq(folderShares.id, shareId),
            or(
                eq(folderShares.userId, userId),
                and(
                    eq(folderShares.receiverUserId, userId),
                    activeShareRecipientExistsCondition(userId),
                ),
            ),
        );
        const [reference] = await tx
            .select()
            .from(folderShares)
            .where(condition);
        if (!reference) throw missing();
        const folder = await ownedFolder(
            tx,
            reference.userId,
            reference.folderId,
        );
        const [share] = await tx
            .select()
            .from(folderShares)
            .where(condition)
            .for("update");
        if (!share) throw missing();
        if (share.version !== input.version) throw conflict();
        const receiver = share.receiverUserId === userId;
        if (input.action === "cancel") {
            if (receiver) throw missing();
            if (share.state !== "pending") throw conflict();
            await tx
                .delete(folderShares)
                .where(
                    and(
                        eq(folderShares.id, shareId),
                        eq(folderShares.userId, userId),
                    ),
                );
            return share;
        }
        if (input.action !== "remove" && !receiver) throw missing();
        const pending = input.action === "accept" || input.action === "decline";
        if (share.state !== (pending ? "pending" : "accepted"))
            throw conflict();
        if (input.action === "accept") {
            const parentId = await attachmentParent(tx, userId, input.parentId);
            await tx.insert(receivedFolderAttachments).values({
                userId,
                shareId,
                name: encryptText(
                    nameOf(input.name ?? decryptText(folder.name)),
                ),
                parentId,
                sortOrder: input.sortOrder ?? 1_000_000,
            });
        } else if (input.action === "remove") {
            await tx
                .delete(receivedFolderAttachments)
                .where(
                    and(
                        eq(receivedFolderAttachments.shareId, shareId),
                        eq(
                            receivedFolderAttachments.userId,
                            share.receiverUserId,
                        ),
                    ),
                );
        } else if (input.action === "rename" || input.action === "move") {
            if (input.action === "rename" && input.name === undefined)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "A folder name is required",
                    400,
                );
            const [updated] = await tx
                .update(receivedFolderAttachments)
                .set({
                    ...(input.action === "rename"
                        ? { name: encryptText(nameOf(input.name ?? "")) }
                        : {
                              parentId: await attachmentParent(
                                  tx,
                                  userId,
                                  input.parentId,
                              ),
                              ...(input.sortOrder !== undefined
                                  ? { sortOrder: input.sortOrder }
                                  : {}),
                          }),
                    version: sql`${receivedFolderAttachments.version} + 1`,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(receivedFolderAttachments.shareId, shareId),
                        eq(receivedFolderAttachments.userId, userId),
                    ),
                )
                .returning({ id: receivedFolderAttachments.id });
            if (!updated) throw missing();
        }
        await tx
            .update(folderShares)
            .set({
                state:
                    input.action === "accept"
                        ? "accepted"
                        : input.action === "decline"
                          ? "declined"
                          : input.action === "remove"
                            ? "removed"
                            : share.state,
                version: share.version + 1,
                respondedAt: pending ? new Date() : share.respondedAt,
                removedAt:
                    input.action === "remove" ? new Date() : share.removedAt,
                updatedAt: new Date(),
            })
            .where(condition);
        return share;
    });
    await Promise.all([
        notifyPersonShareChanged(changed.userId),
        notifyPersonShareChanged(changed.receiverUserId),
    ]);
}

/** Receiver-owned navigation nodes and live placements, never processing assignments. */
export async function listReceivedFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    if (!isOrgScopeVisible()) return { folders: [], assignments: [] };
    const rows = await db
        .select({
            attachment: receivedFolderAttachments,
            share: folderShares,
            originalName: recordingFolders.name,
            ownerName: users.name,
            ownerEmail: users.email,
        })
        .from(receivedFolderAttachments)
        .innerJoin(
            folderShares,
            and(
                eq(folderShares.id, receivedFolderAttachments.shareId),
                eq(folderShares.receiverUserId, userId),
            ),
        )
        .innerJoin(
            recordingFolders,
            and(
                eq(recordingFolders.id, folderShares.folderId),
                eq(recordingFolders.userId, folderShares.userId),
            ),
        )
        .innerJoin(users, eq(users.id, folderShares.userId))
        .where(
            and(
                eq(receivedFolderAttachments.userId, userId),
                eq(folderShares.state, "accepted"),
                activeShareRecipientExistsCondition(userId),
            ),
        );
    const [root] = rows.some((row) => row.attachment.parentId === null)
        ? await db
              .select({ id: recordingFolders.id })
              .from(recordingFolders)
              .where(
                  and(
                      eq(recordingFolders.userId, userId),
                      eq(recordingFolders.kind, "private"),
                  ),
              )
              .limit(1)
        : [];
    const folders: RecordingFolder[] = rows.map(
        ({ attachment, share, originalName, ownerName, ownerEmail }) => ({
            id: attachment.id,
            name: decryptText(attachment.name),
            parentId: attachment.parentId ?? root?.id ?? null,
            sortOrder: attachment.sortOrder,
            version: attachment.version,
            kind: "custom",
            scope: "personal",
            receivedFolder: {
                shareId: share.id,
                shareVersion: share.version,
                ownerName: ownerName || ownerEmail,
                originalName: decryptText(originalName),
            },
        }),
    );
    if (!rows.length) return { folders, assignments: [] };
    const assignments = await db
        .select({
            recordingId: recordingFolderAssignments.itemId,
            folderId: receivedFolderAttachments.id,
        })
        .from(receivedFolderAttachments)
        .innerJoin(
            folderShares,
            and(
                eq(folderShares.id, receivedFolderAttachments.shareId),
                eq(folderShares.receiverUserId, userId),
            ),
        )
        .innerJoin(
            recordingFolderAssignments,
            and(
                eq(recordingFolderAssignments.folderId, folderShares.folderId),
                eq(recordingFolderAssignments.userId, folderShares.userId),
            ),
        )
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingFolderAssignments.itemId),
                eq(chatterItems.userId, folderShares.userId),
            ),
        )
        .where(
            and(
                eq(receivedFolderAttachments.userId, userId),
                eq(folderShares.state, "accepted"),
                activeShareRecipientExistsCondition(userId),
                isNull(chatterItems.deletedAt),
            ),
        );
    return { folders, assignments };
}

/** Refresh receivers after live membership, shared-folder naming or deletion changes. */
export async function notifyFolderSharesChanged(userId: string) {
    if (!isOrgScopeVisible()) return;
    const rows = await db
        .select({ receiverId: folderShares.receiverUserId })
        .from(folderShares)
        .where(
            and(
                eq(folderShares.userId, userId),
                inArray(folderShares.state, ["pending", "accepted"]),
            ),
        );
    await Promise.all(
        [...new Set(rows.map((row) => row.receiverId))].map(
            notifyPersonShareChanged,
        ),
    );
}

/** Remove a folder's shares before deletion or Organization publication, in the owner's transaction. */
export async function endFolderSharesInTx(
    tx: Tx,
    userId: string,
    folderIds: string[],
) {
    if (!folderIds.length) return [];
    const rows = await tx
        .delete(folderShares)
        .where(
            and(
                eq(folderShares.userId, userId),
                inArray(folderShares.folderId, folderIds),
            ),
        )
        .returning({ receiverId: folderShares.receiverUserId });
    return [...new Set(rows.map((row) => row.receiverId))];
}

/** Active outgoing markers for the owner's private tree. */
export async function sharedFolderIds(userId: string) {
    if (!isOrgScopeVisible()) return new Set<string>();
    const rows = await db
        .select({ folderId: folderShares.folderId })
        .from(folderShares)
        .where(
            and(
                eq(folderShares.userId, userId),
                inArray(folderShares.state, ["pending", "accepted"]),
            ),
        );
    return new Set(rows.map((row) => row.folderId));
}
