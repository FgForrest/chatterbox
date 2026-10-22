import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, itemShares, recordingFolders, users } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { notifyPersonShareChanged } from "@/lib/events/personal";
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
                    ne(users.role, "org"),
                    ne(users.id, userId),
                ),
            );
        if (receivers.length !== ids.length) throw missing();
        for (const receiverUserId of ids) {
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
            kind: chatterItems.kind,
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
            ),
        )
        .orderBy(asc(itemShares.invitedAt));
    return rows.map((row) => ({
        ...row,
        title: decryptText(row.title),
        ownerName: row.ownerName || row.ownerEmail,
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
            if (!input.folderId)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Choose a private folder",
                    400,
                );
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
                ne(users.role, "org"),
                or(
                    sql`${users.name} ilike ${pattern} escape '\\'`,
                    sql`${users.email} ilike ${pattern} escape '\\'`,
                ),
            ),
        )
        .orderBy(asc(users.name), asc(users.id))
        .limit(10);
}
