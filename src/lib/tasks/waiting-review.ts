import { and, eq, exists, isNull, notExists, or } from "drizzle-orm";
import type { db } from "@/db";
import { reviewableTaskTargetCondition } from "@/db/queries/tasks";
import {
    chatterItems,
    mailPendingShares,
    recordingTasks,
    taskMentions,
    taskUpdateProposals,
} from "@/db/schema";
import { taskReviewState } from "@/lib/tasks/review-state";

type Executor = Pick<typeof db, "select">;

/** Distinct review decisions split for pipeline presentation. */
export interface WaitingTaskDecisions {
    proposals: number;
    followUps: number;
    total: number;
}

/** Find private audio shares whose owner is reviewing this authorized target. */
export async function intendedSharesReviewingTask(
    executor: Executor & Pick<typeof db, "selectDistinct">,
    taskId: string,
    targetOwnerUserId: string,
): Promise<{ itemId: string; userId: string }[]> {
    const sources = await executor
        .selectDistinct({
            itemId: mailPendingShares.itemId,
            userId: mailPendingShares.userId,
        })
        .from(mailPendingShares)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailPendingShares.itemId),
                eq(chatterItems.userId, mailPendingShares.userId),
            ),
        )
        .innerJoin(
            recordingTasks,
            and(
                eq(recordingTasks.id, taskId),
                eq(recordingTasks.userId, targetOwnerUserId),
            ),
        )
        .where(
            and(
                eq(chatterItems.kind, "audio"),
                isNull(chatterItems.deletedAt),
                reviewableTaskTargetCondition(taskId, mailPendingShares.userId),
                or(
                    exists(
                        executor
                            .select({ id: taskUpdateProposals.id })
                            .from(taskUpdateProposals)
                            .where(
                                and(
                                    eq(taskUpdateProposals.taskId, taskId),
                                    eq(
                                        taskUpdateProposals.itemId,
                                        mailPendingShares.itemId,
                                    ),
                                    eq(
                                        taskUpdateProposals.userId,
                                        mailPendingShares.userId,
                                    ),
                                    eq(
                                        taskUpdateProposals.state,
                                        "awaiting_source_review",
                                    ),
                                ),
                            ),
                    ),
                    exists(
                        executor
                            .select({ id: taskMentions.id })
                            .from(taskMentions)
                            .where(
                                and(
                                    eq(taskMentions.taskId, taskId),
                                    eq(
                                        taskMentions.itemId,
                                        mailPendingShares.itemId,
                                    ),
                                    eq(
                                        taskMentions.userId,
                                        mailPendingShares.userId,
                                    ),
                                    eq(taskMentions.matchDecision, "suggested"),
                                    eq(taskMentions.view, "private"),
                                ),
                            ),
                    ),
                ),
            ),
        )
        .orderBy(mailPendingShares.itemId, mailPendingShares.userId);
    const waiting = await Promise.all(
        sources.map(
            async ({ itemId, userId }) =>
                (
                    await waitingTaskDecisions(
                        executor,
                        itemId,
                        userId,
                        "private",
                    )
                ).total,
        ),
    );
    return sources.filter((_, index) => waiting[index] > 0);
}

/** Counts distinct source-review decisions for one owner-scoped item. */
export async function waitingTaskDecisions(
    executor: Executor,
    itemId: string,
    ownerUserId: string,
    view?: "private" | "org",
    includeSkipped = false,
    reviewView: "private" | "org" = view ?? "private",
): Promise<WaitingTaskDecisions> {
    if (
        !includeSkipped &&
        (
            await taskReviewState(executor, {
                itemId,
                userId: ownerUserId,
                view: reviewView,
            })
        ).skipped
    ) {
        return { proposals: 0, followUps: 0, total: 0 };
    }
    const [newTasks, followUps, matches] = await Promise.all([
        executor
            .select({ taskId: recordingTasks.id })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, itemId),
                    eq(recordingTasks.userId, ownerUserId),
                    eq(recordingTasks.status, "proposed"),
                ),
            ),
        executor
            .select({ taskId: taskUpdateProposals.taskId })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.itemId, itemId),
                    eq(taskUpdateProposals.userId, ownerUserId),
                    eq(taskUpdateProposals.state, "awaiting_source_review"),
                    reviewableTaskTargetCondition(
                        taskUpdateProposals.taskId,
                        ownerUserId,
                        view === "org",
                    ),
                ),
            ),
        executor
            .select({ taskId: taskMentions.taskId })
            .from(taskMentions)
            .where(
                and(
                    eq(taskMentions.itemId, itemId),
                    eq(taskMentions.userId, ownerUserId),
                    eq(taskMentions.matchDecision, "suggested"),
                    view ? eq(taskMentions.view, view) : undefined,
                    reviewableTaskTargetCondition(
                        taskMentions.taskId,
                        ownerUserId,
                        view === "org",
                    ),
                    notExists(
                        executor
                            .select({ id: taskUpdateProposals.id })
                            .from(taskUpdateProposals)
                            .where(
                                and(
                                    eq(taskUpdateProposals.itemId, itemId),
                                    eq(taskUpdateProposals.userId, ownerUserId),
                                    eq(
                                        taskUpdateProposals.taskId,
                                        taskMentions.taskId,
                                    ),
                                    eq(taskUpdateProposals.state, "obsolete"),
                                    eq(
                                        taskUpdateProposals.obsoleteReason,
                                        "earlier_statement",
                                    ),
                                    isNull(taskUpdateProposals.decidedByUserId),
                                ),
                            ),
                    ),
                ),
            ),
    ]);
    const followUpTaskIds = new Set(followUps.map((row) => row.taskId));
    const matchOnlyTaskIds = new Set(
        matches
            .map((row) => row.taskId)
            .filter((taskId) => !followUpTaskIds.has(taskId)),
    );
    const proposedTaskIds = new Set(newTasks.map((row) => row.taskId));

    return {
        proposals: proposedTaskIds.size + matchOnlyTaskIds.size,
        followUps: followUpTaskIds.size,
        total:
            proposedTaskIds.size + followUpTaskIds.size + matchOnlyTaskIds.size,
    };
}
