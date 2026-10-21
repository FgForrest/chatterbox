import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import { mailPendingShares, recordingFolderAssignments } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { publishKnowledgeInTx } from "@/lib/knowledge/share-knowledge";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";
import { publishTaskAssigneesInTx } from "@/lib/sharing/share-names";
import { isRecordingShared } from "@/lib/sharing/shared";
import { waitingTaskDecisions } from "@/lib/tasks/waiting-review";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What keeps a mail out of the Organization: an undecided task proposal. Proposal-state filtering follows specification section 7.8;
 * Stage 4 narrows both share gates to `awaiting_source_review`.
 */
export async function mailShareProblems(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
): Promise<ShareGateProblem[]> {
    const taskDecisions = await waitingTaskDecisions(tx, itemId, ownerUserId);
    const problems: ShareGateProblem[] = [];
    const waitingProposals = taskDecisions.total;
    if (waitingProposals > 0) {
        problems.push({
            kind: "tasks_unreviewed",
            proposals: waitingProposals,
        });
    }
    return problems;
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
    const problems = wasShared
        ? []
        : await mailShareProblems(tx, input.itemId, input.ownerUserId);
    if (problems.length > 0) {
        throw new AppError(
            ErrorCode.SHARE_REQUIREMENTS_UNMET,
            "Finish the review before sharing",
            409,
            { problems },
        );
    }
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
