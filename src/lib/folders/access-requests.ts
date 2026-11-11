import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { lockOrgTree } from "@/db/queries/organization-tree";
import {
    notifyRestrictedAudienceInTx,
    restrictedMemberCondition,
} from "@/db/queries/restricted-folders";
import { activeShareRecipientExistsCondition } from "@/db/queries/share-recipients";
import {
    recordingFolders,
    restrictedFolderAccessRequests as requests,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import { holderAccess } from "@/lib/authz/access-state";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { notifyPersonShareChanged } from "@/lib/events/personal";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";
import {
    assertOrgScopeWritable,
    getOrgUserId,
    isOrgScopeVisible,
} from "@/lib/org/config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function refused() {
    return new AppError(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN, 403);
}

async function authority(userId: string) {
    assertOrgScopeWritable();
    const curator = await userCuratesOrganizationNow(userId);
    return { userId, curator, orgUserId: await getOrgUserId() };
}

/** Recheck stored authority on the transaction executor after taking the tree lock. */
export async function restrictedAudienceAuthorityInTx(
    tx: Tx,
    userId: string,
    folderId: string,
    knownCurator: boolean,
    managerOnly = false,
    curatorOnly = false,
) {
    if (knownCurator) {
        if (!isIdpAuthorization()) return;
        const access = await holderAccess(userId, {
            executor: tx,
            verify: false,
        });
        const [active] = await tx
            .select({ id: users.id })
            .from(users)
            .where(
                and(
                    eq(users.id, userId),
                    activeShareRecipientExistsCondition(userId),
                ),
            );
        if (active && access.ok && access.capabilities.has("org.curate"))
            return;
    }
    if (curatorOnly) throw refused();
    const [member] = await tx
        .select({ role: restrictedFolderMembers.role })
        .from(restrictedFolderMembers)
        .where(
            and(
                eq(restrictedFolderMembers.folderId, folderId),
                eq(restrictedFolderMembers.userId, userId),
                restrictedMemberCondition(
                    userId,
                    restrictedFolderMembers.folderId,
                ),
            ),
        );
    if (!member)
        throw new AppError(
            ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
            403,
        );
    if (managerOnly && member.role !== "manager") throw refused();
}

async function folderInTx(
    tx: Tx,
    auth: Awaited<ReturnType<typeof authority>>,
    folderId: string,
) {
    const [folder] = await tx
        .select({
            id: recordingFolders.id,
            restrictedAt: recordingFolders.restrictedAt,
        })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, folderId),
                auth.orgUserId
                    ? eq(recordingFolders.userId, auth.orgUserId)
                    : sql`false`,
            ),
        );
    if (!folder)
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    if (!folder.restrictedAt) throw refused();
    return folder;
}

async function requireRequesterInTx(
    tx: Tx,
    auth: Awaited<ReturnType<typeof authority>>,
    folderId: string,
) {
    await folderInTx(tx, auth, folderId);
    const [requester] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
            and(
                eq(users.id, auth.userId),
                activeShareRecipientExistsCondition(auth.userId),
                sql`not (${restrictedMemberCondition(auth.userId, folderId)})`,
            ),
        );
    if (!requester || auth.curator) throw refused();
}

/** A single pending request per person and folder; retries do not send another invitation. */
export async function requestRestrictedFolderAccess(
    userId: string,
    folderId: string,
) {
    const auth = await authority(userId);
    const result = await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await requireRequesterInTx(tx, auth, folderId);
        const [pending] = await tx
            .select()
            .from(requests)
            .where(
                and(
                    eq(requests.folderId, folderId),
                    eq(requests.userId, userId),
                    eq(requests.state, "pending"),
                ),
            );
        if (pending) return { request: pending, recipients: [] as string[] };
        const [request] = await tx
            .insert(requests)
            .values({ folderId, userId })
            .returning();
        const recipients = await tx
            .select({ userId: restrictedFolderMembers.userId })
            .from(restrictedFolderMembers)
            .where(
                and(
                    eq(restrictedFolderMembers.folderId, folderId),
                    activeShareRecipientExistsCondition(
                        restrictedFolderMembers.userId,
                    ),
                ),
            );
        await notifyRestrictedAudienceInTx(tx, folderId);
        return {
            request,
            recipients: recipients.map((member) => member.userId),
        };
    });
    await Promise.all(
        result.recipients.map((id) =>
            sendPersonShareInvitation(id, "access-request").catch(() => {
                console.error("[folder-access] invitation email failed");
            }),
        ),
    );
    await notifyPersonShareChanged(userId);
    return { request: result.request };
}

/** Cancel only the caller's pending request. */
export async function cancelRestrictedFolderAccessRequest(
    userId: string,
    folderId: string,
) {
    const auth = await authority(userId);
    await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await requireRequesterInTx(tx, auth, folderId);
        await tx
            .update(requests)
            .set({ state: "cancelled", decidedAt: new Date() })
            .where(
                and(
                    eq(requests.folderId, folderId),
                    eq(requests.userId, userId),
                    eq(requests.state, "pending"),
                ),
            );
        await notifyRestrictedAudienceInTx(tx, folderId);
    });
    await notifyPersonShareChanged(userId);
    return { cancelled: true };
}

/** Pending identities are visible only to audience members and curators. */
export async function listRestrictedFolderAccessRequests(
    userId: string,
    folderId: string,
) {
    const auth = await authority(userId);
    return db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await folderInTx(tx, auth, folderId);
        await restrictedAudienceAuthorityInTx(
            tx,
            userId,
            folderId,
            auth.curator,
        );
        return {
            requests: await tx
                .select({
                    id: requests.id,
                    folderId: requests.folderId,
                    userId: requests.userId,
                    name: users.name,
                    email: users.email,
                    state: requests.state,
                    createdAt: requests.createdAt,
                })
                .from(requests)
                .innerJoin(users, eq(users.id, requests.userId))
                .where(
                    and(
                        eq(requests.folderId, folderId),
                        eq(requests.state, "pending"),
                        activeShareRecipientExistsCondition(requests.userId),
                    ),
                )
                .orderBy(asc(requests.createdAt)),
        };
    });
}

/** Decide once, with membership insertion and the decision in the same locked transaction. */
export async function decideRestrictedFolderAccessRequest(
    userId: string,
    folderId: string,
    requestId: string,
    state: "approved" | "declined",
) {
    const auth = await authority(userId);
    const request = await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await folderInTx(tx, auth, folderId);
        await restrictedAudienceAuthorityInTx(
            tx,
            userId,
            folderId,
            auth.curator,
        );
        const [request] = await tx
            .update(requests)
            .set({ state, decidedByUserId: userId, decidedAt: new Date() })
            .where(
                and(
                    eq(requests.id, requestId),
                    eq(requests.folderId, folderId),
                    eq(requests.state, "pending"),
                    activeShareRecipientExistsCondition(requests.userId),
                ),
            )
            .returning();
        if (!request)
            throw new AppError(
                ErrorCode.RESTRICTED_FOLDER_REQUEST_NOT_PENDING,
                ErrorCode.RESTRICTED_FOLDER_REQUEST_NOT_PENDING,
                409,
            );
        if (state === "approved")
            await tx
                .insert(restrictedFolderMembers)
                .values({
                    folderId,
                    userId: request.userId,
                    addedByUserId: userId,
                })
                .onConflictDoNothing();
        await notifyRestrictedAudienceInTx(tx, folderId);
        return request;
    });
    await notifyRestrictedAccessDecision(request.userId, state);
    return { request };
}

/** Content-free decision email and personal invalidation, also used for direct additions. */
export async function notifyRestrictedAccessDecision(
    userId: string,
    state: "approved" | "declined",
) {
    await notifyPersonShareChanged(userId);
    await sendPersonShareInvitation(
        userId,
        state === "approved" ? "access-approved" : "access-declined",
    ).catch(() => {
        console.error("[folder-access] decision email failed");
    });
}

/** Invitation inbox entries: audience-only pending requests and the caller's unread decisions. */
export async function listMyRestrictedAccessInvitations(userId: string) {
    if (!isOrgScopeVisible()) return [];
    const orgId = await getOrgUserId();
    if (!orgId) return [];
    const rows = await db
        .select({
            id: requests.id,
            folderId: requests.folderId,
            folderName: recordingFolders.name,
            userId: requests.userId,
            name: users.name,
            state: requests.state,
            invitedAt: requests.createdAt,
            decidedAt: requests.decidedAt,
        })
        .from(requests)
        .innerJoin(recordingFolders, eq(recordingFolders.id, requests.folderId))
        .innerJoin(users, eq(users.id, requests.userId))
        .where(
            and(
                eq(recordingFolders.userId, orgId),
                or(
                    and(
                        eq(requests.state, "pending"),
                        isNotNull(recordingFolders.restrictedAt),
                        restrictedMemberCondition(userId),
                        activeShareRecipientExistsCondition(requests.userId),
                    ),
                    and(
                        eq(requests.userId, userId),
                        inArray(requests.state, ["approved", "declined"]),
                        isNull(requests.noticeReadAt),
                    ),
                ),
            ),
        )
        .orderBy(asc(requests.createdAt));
    return rows.map((row) => ({
        ...row,
        folderName: decryptText(row.folderName),
        title: decryptText(row.folderName),
        ownerName: row.name ?? "",
        itemId: row.folderId,
        kind: "folder-access" as const,
        notice: row.state !== "pending",
    }));
}

/** A requester dismisses only their own decided notice. */
export async function dismissRestrictedAccessNotice(
    userId: string,
    folderId: string,
    requestId: string,
) {
    assertOrgScopeWritable();
    await db
        .update(requests)
        .set({ noticeReadAt: new Date() })
        .where(
            and(
                eq(requests.id, requestId),
                eq(requests.folderId, folderId),
                eq(requests.userId, userId),
                inArray(requests.state, ["approved", "declined"]),
            ),
        );
    return { dismissed: true };
}
