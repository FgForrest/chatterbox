import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { queryItemFolderAudience } from "@/db/queries/item-folder-audience";
import {
    activeShareRecipientCondition,
    queryVisibleItemFolders,
} from "@/db/queries/item-shares";
import { chatterItems, itemShares, recordingFolders, users } from "@/db/schema";
import { contentKindColumn } from "@/lib/content/item-kinds";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { notifyPersonShareChanged } from "@/lib/events/personal";
import { secretAddressMasker } from "@/lib/mail/redact";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";
import {
    getOrgUserId,
    isOrgAccount,
    isOrgScopeVisible,
} from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

/** Refuse person sharing outside the self-host Organization scope and for its account. */
export async function requirePersonSharing(userId: string): Promise<void> {
    if (!isOrgScopeVisible() || (await isOrgAccount(userId))) throw missing();
}

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

async function requireOwner(userId: string, itemId: string) {
    await requirePersonSharing(userId);
    const [item] = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, userId),
                isNull(chatterItems.deletedAt),
                inArray(chatterItems.kind, ["audio", "mail"]),
            ),
        )
        .limit(1);
    if (!item) throw missing();
}

/** The owner's direct shares, including past responses. */
export async function listItemShares(userId: string, itemId: string) {
    await requireOwner(userId, itemId);
    return db
        .select({
            id: itemShares.id,
            receiverUserId: itemShares.receiverUserId,
            name: users.name,
            email: users.email,
            state: itemShares.state,
            version: itemShares.version,
            invitedAt: itemShares.invitedAt,
            respondedAt: itemShares.respondedAt,
        })
        .from(itemShares)
        .innerJoin(users, eq(users.id, itemShares.receiverUserId))
        .where(
            and(
                eq(itemShares.userId, userId),
                eq(itemShares.itemId, itemId),
                isNull(itemShares.folderShareId),
            ),
        )
        .orderBy(asc(itemShares.createdAt));
}

/** Folder participants and names visible to this item's owner, never receiver placements. */
export async function listItemFolderAudience(userId: string, itemId: string) {
    await requireOwner(userId, itemId);
    const rows = await queryItemFolderAudience(db, userId, itemId);
    const names = rows.map((row) => decryptText(row.folder_name ?? ""));
    const mask = await secretAddressMasker(names);
    return rows.map((row, index) => ({
        folderId: row.folder_id,
        folderName: mask(names[index]),
        canManage: row.can_manage,
        receiverUserId: row.receiver_user_id,
        name: row.name,
        email: row.email,
        state: row.state,
    }));
}

/** Receiver-only folder labels for accepted live paths to these items. */
export async function listVisibleItemFolders(
    userId: string,
    itemIds: string[],
) {
    const rows = await queryVisibleItemFolders(db, userId, itemIds);
    const names = rows.map((row) => decryptText(row.name));
    const mask = await secretAddressMasker(names);
    return rows.map((row, index) => ({
        itemId: row.item_id,
        id: row.id,
        name: mask(names[index]),
    }));
}

/** Invite members without publishing the item or changing its processing folders. */
export async function inviteToItem(
    userId: string,
    itemId: string,
    receiverIds: string[],
) {
    await requireOwner(userId, itemId);
    const ids = [...new Set(receiverIds)];
    if (!ids.length || ids.length > 20 || ids.includes(userId))
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Choose between one and twenty colleagues",
            400,
        );
    const orgUserId = await getOrgUserId();
    const invitedIds: string[] = [];
    await db.transaction(async (tx) => {
        const [item] = await tx
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, userId),
                    isNull(chatterItems.deletedAt),
                    inArray(chatterItems.kind, ["audio", "mail"]),
                ),
            )
            .for("update");
        if (!item) throw missing();
        if (orgUserId && (await isRecordingShared(itemId, orgUserId, tx)))
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "The Organization already sees this item",
                403,
            );
        const receivers = await tx
            .select({ id: users.id })
            .from(users)
            .where(
                and(
                    inArray(users.id, ids),
                    activeShareRecipientCondition(),
                    ne(users.id, userId),
                ),
            );
        if (receivers.length !== ids.length) throw missing();
        const folderAudience = new Set(
            (await queryItemFolderAudience(tx, userId, itemId)).map(
                (row) => row.receiver_user_id,
            ),
        );
        for (const receiverUserId of ids) {
            if (folderAudience.has(receiverUserId)) continue;
            const [existing] = await tx
                .select()
                .from(itemShares)
                .where(
                    and(
                        eq(itemShares.userId, userId),
                        eq(itemShares.itemId, itemId),
                        eq(itemShares.receiverUserId, receiverUserId),
                        isNull(itemShares.folderShareId),
                    ),
                )
                .for("update");
            if (
                existing &&
                (existing.state === "pending" || existing.state === "accepted")
            )
                continue;
            invitedIds.push(receiverUserId);
            if (existing) {
                await tx
                    .update(itemShares)
                    .set({
                        state: "pending",
                        filingFolderId: null,
                        invitedAt: new Date(),
                        respondedAt: null,
                        removedAt: null,
                        invitedByUserId: userId,
                        version: existing.version + 1,
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(itemShares.id, existing.id),
                            eq(itemShares.userId, userId),
                        ),
                    );
            } else {
                await tx.insert(itemShares).values({
                    userId,
                    receiverUserId,
                    itemId,
                    invitedByUserId: userId,
                });
            }
        }
    });
    await Promise.all(invitedIds.map(notifyPersonShareChanged));
    for (const receiverId of invitedIds)
        void sendPersonShareInvitation(receiverId).catch(() => {
            console.error("[person-shares] invitation email failed");
        });
    return listItemShares(userId, itemId);
}

/** Pending invitations expose only the item's title and owner. */
export async function listMyInvitations(userId: string) {
    await requirePersonSharing(userId);
    const rows = await db
        .select({
            id: itemShares.id,
            itemId: itemShares.itemId,
            kind: contentKindColumn(chatterItems.kind),
            title: chatterItems.title,
            ownerName: users.name,
            ownerEmail: users.email,
            invitedAt: itemShares.invitedAt,
            version: itemShares.version,
        })
        .from(itemShares)
        .innerJoin(chatterItems, eq(chatterItems.id, itemShares.itemId))
        .innerJoin(users, eq(users.id, itemShares.userId))
        .where(
            and(
                eq(itemShares.receiverUserId, userId),
                eq(itemShares.state, "pending"),
                isNull(chatterItems.deletedAt),
                inArray(chatterItems.kind, ["audio", "mail"]),
            ),
        )
        .orderBy(asc(itemShares.invitedAt));
    const mask = await secretAddressMasker(
        rows
            .filter((row) => row.kind === "mail")
            .map((row) => decryptText(row.title)),
    );
    const visibleFolders = await listVisibleItemFolders(
        userId,
        rows.map((row) => row.itemId),
    );
    return rows
        .filter(
            (row): row is typeof row & { kind: "audio" | "mail" } =>
                row.kind !== null,
        )
        .map((row) => ({
            ...row,
            title:
                row.kind === "mail"
                    ? mask(decryptText(row.title))
                    : decryptText(row.title),
            ownerName: row.ownerName || row.ownerEmail,
            visibleInFolders: visibleFolders
                .filter((folder) => folder.itemId === row.itemId)
                .map(({ id, name }) => ({ id, name })),
        }));
}

/** State and version checked changes, serialized against cancellation and other responses. */
export async function changePersonShare(
    userId: string,
    shareId: string,
    input: {
        action: "accept" | "decline" | "remove" | "cancel" | "file";
        version: number;
        folderId?: string;
    },
) {
    await requirePersonSharing(userId);
    const changed = await db.transaction(async (tx) => {
        const [reference] = await tx
            .select({ itemId: itemShares.itemId, ownerId: itemShares.userId })
            .from(itemShares)
            .where(
                and(
                    eq(itemShares.id, shareId),
                    or(
                        eq(itemShares.userId, userId),
                        eq(itemShares.receiverUserId, userId),
                    ),
                ),
            )
            .limit(1);
        if (!reference) throw missing();
        const [item] = await tx
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, reference.itemId),
                    eq(chatterItems.userId, reference.ownerId),
                    isNull(chatterItems.deletedAt),
                    inArray(chatterItems.kind, ["audio", "mail"]),
                ),
            )
            .for("update");
        if (!item) throw missing();
        const [share] = await tx
            .select()
            .from(itemShares)
            .where(
                and(
                    eq(itemShares.id, shareId),
                    or(
                        eq(itemShares.userId, userId),
                        eq(itemShares.receiverUserId, userId),
                    ),
                ),
            )
            .for("update");
        if (!share) throw missing();
        if (share.version !== input.version) throw conflict();
        const owner = share.userId === userId;
        const receiver = share.receiverUserId === userId;
        if (input.action === "cancel") {
            if (!owner) throw missing();
            if (share.state !== "pending") throw conflict();
            await tx
                .delete(itemShares)
                .where(
                    and(
                        eq(itemShares.id, shareId),
                        eq(itemShares.userId, userId),
                    ),
                );
            return share;
        }
        if (input.action === "remove") {
            if (share.state !== "accepted") throw conflict();
        } else if (!receiver) throw missing();
        if (
            (input.action === "accept" || input.action === "decline") &&
            share.state !== "pending"
        )
            throw conflict();
        if (input.action === "file" && share.state !== "accepted")
            throw conflict();
        let filingFolderId = share.filingFolderId;
        if (input.action === "accept" || input.action === "file") {
            if (!input.folderId) {
                const paths = await queryVisibleItemFolders(tx, userId, [
                    share.itemId,
                ]);
                if (!paths.length)
                    throw new AppError(
                        ErrorCode.INVALID_INPUT,
                        "Choose a private folder",
                        400,
                    );
                filingFolderId = null;
            } else {
                const [folder] = await tx
                    .select({ id: recordingFolders.id })
                    .from(recordingFolders)
                    .where(
                        and(
                            eq(recordingFolders.id, input.folderId),
                            eq(recordingFolders.userId, userId),
                            ne(recordingFolders.kind, "public"),
                        ),
                    )
                    .for("share");
                if (!folder) throw missing();
                filingFolderId = folder.id;
            }
        }
        await tx
            .update(itemShares)
            .set({
                state:
                    input.action === "accept"
                        ? "accepted"
                        : input.action === "decline"
                          ? "declined"
                          : input.action === "remove"
                            ? "removed"
                            : share.state,
                filingFolderId:
                    input.action === "remove" ? null : filingFolderId,
                respondedAt:
                    input.action === "accept" || input.action === "decline"
                        ? new Date()
                        : share.respondedAt,
                removedAt: input.action === "remove" ? new Date() : null,
                version: share.version + 1,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(itemShares.id, shareId),
                    owner
                        ? eq(itemShares.userId, userId)
                        : eq(itemShares.receiverUserId, userId),
                ),
            );
        return share;
    });
    await Promise.all([
        notifyPersonShareChanged(changed.userId),
        notifyPersonShareChanged(changed.receiverUserId),
    ]);
}

/** Limited directory search for colleagues, with literal name and e-mail matching. */
export async function findShareRecipients(userId: string, query: string) {
    await requirePersonSharing(userId);
    const term = query.trim();
    if (term.length < 2 || term.length > 100) return [];
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    return db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
            and(
                ne(users.id, userId),
                activeShareRecipientCondition(),
                or(
                    sql`${users.name} ilike ${pattern} escape '\\'`,
                    sql`${users.email} ilike ${pattern} escape '\\'`,
                ),
            ),
        )
        .orderBy(asc(users.name), asc(users.id))
        .limit(10);
}
