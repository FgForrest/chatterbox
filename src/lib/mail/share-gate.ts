import { and, count, eq } from "drizzle-orm";
import type { db } from "@/db";
import {
    learnRuns,
    mailPendingShares,
    recordingFolderAssignments,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { publishKnowledgeInTx } from "@/lib/knowledge/share-knowledge";
import { learnRunOpen } from "@/lib/learn/learn-open";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";
import { publishTaskAssigneesInTx } from "@/lib/sharing/share-names";
import { isRecordingShared } from "@/lib/sharing/shared";
import { liveFollowUpCondition } from "@/lib/tasks/store";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What keeps a mail out of the Organization: an open Learn run or undecided
 * task proposal. Proposal-state filtering follows specification section 7.8;
 * Stage 4 narrows both share gates to `awaiting_source_review`.
 */
export async function mailShareProblems(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
): Promise<ShareGateProblem[]> {
    const [[openRuns], [proposals], [followUps], [matches]] = await Promise.all(
        [
            tx
                .select({ n: count() })
                .from(learnRuns)
                .where(
                    and(
                        eq(learnRuns.itemId, itemId),
                        eq(learnRuns.userId, ownerUserId),
                        learnRunOpen(),
                    ),
                ),
            tx
                .select({ n: count() })
                .from(recordingTasks)
                .where(
                    and(
                        eq(recordingTasks.itemId, itemId),
                        eq(recordingTasks.userId, ownerUserId),
                        eq(recordingTasks.status, "proposed"),
                    ),
                ),
            tx
                .select({ n: count() })
                .from(taskUpdateProposals)
                .where(
                    and(
                        eq(taskUpdateProposals.itemId, itemId),
                        eq(taskUpdateProposals.userId, ownerUserId),
                        liveFollowUpCondition(),
                    ),
                ),
            tx
                .select({ n: count() })
                .from(taskMentions)
                .where(
                    and(
                        eq(taskMentions.itemId, itemId),
                        eq(taskMentions.userId, ownerUserId),
                        eq(taskMentions.matchDecision, "suggested"),
                    ),
                ),
        ],
    );
    const problems: ShareGateProblem[] = [];
    if ((openRuns?.n ?? 0) > 0) {
        problems.push({ kind: "learn_unfinished", runs: openRuns?.n ?? 0 });
    }
    const waitingProposals =
        (proposals?.n ?? 0) + (followUps?.n ?? 0) + (matches?.n ?? 0);
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
