import { and, eq, isNull, notExists } from "drizzle-orm";
import type { db } from "@/db";
import { reviewableTaskTargetCondition } from "@/db/queries/tasks";
import { recordingTasks, taskMentions, taskUpdateProposals } from "@/db/schema";

type Executor = Pick<typeof db, "select">;

/** Distinct review decisions split for pipeline presentation. */
export interface WaitingTaskDecisions {
    proposals: number;
    followUps: number;
    total: number;
}

/** Counts distinct source-review decisions for one owner-scoped item. */
export async function waitingTaskDecisions(
    executor: Executor,
    itemId: string,
    ownerUserId: string,
    view?: "private" | "org",
): Promise<WaitingTaskDecisions> {
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
