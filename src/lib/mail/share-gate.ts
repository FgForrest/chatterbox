import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import { mailPendingShares, recordingFolderAssignments } from "@/db/schema";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { publishKnowledgeInTx } from "@/lib/knowledge/share-knowledge";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";
import { publishTaskAssigneesInTx } from "@/lib/sharing/share-names";
import { isRecordingShared } from "@/lib/sharing/shared";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mail sharing has no content-review prerequisites.
 */
export async function mailShareProblems(
    _tx: Tx,
    _itemId: string,
    _ownerUserId: string,
): Promise<ShareGateProblem[]> {
    return [];
}

/**
 * Shares the owner's mail into an Organization folder in the caller's
 * transaction, which holds the Organization tree lock, the Organization
 * people lock and the item's. The first Organization folder passes the
 * gate and publishes its task assignees; another one only files it. A
 * wish to share it there is fulfilled.
 */
export async function shareMailInTx(
    tx: Tx,
    input: {
        ownerUserId: string;
        itemId: string;
        folderId: string;
        orgUserId: string;
    },
): Promise<void> {
    const wasShared = await isRecordingShared(
        input.itemId,
        input.orgUserId,
        tx,
    );
    await tx
        .insert(recordingFolderAssignments)
        .values({
            userId: input.ownerUserId,
            itemId: input.itemId,
            folderId: input.folderId,
        })
        .onConflictDoNothing();
    await tx
        .delete(mailPendingShares)
        .where(
            and(
                eq(mailPendingShares.itemId, input.itemId),
                eq(mailPendingShares.userId, input.ownerUserId),
                eq(mailPendingShares.folderId, input.folderId),
            ),
        );
    if (wasShared) return;
    const knowledge = await publishKnowledgeInTx(tx, {
        recordingId: input.itemId,
        ownerUserId: input.ownerUserId,
        orgUserId: input.orgUserId,
    });
    const assignees = await publishTaskAssigneesInTx(tx, {
        recordingId: input.itemId,
        orgUserId: input.orgUserId,
    });
    await bumpScopeInTx(tx, [...knowledge.scopes, ...assignees]);
}
