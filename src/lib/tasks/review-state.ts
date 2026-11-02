import { and, eq, isNotNull, notExists, type SQLWrapper } from "drizzle-orm";
import { db } from "@/db";
import { writeTaskReviewMarkerInTx } from "@/db/queries/task-review";
import { itemProcessing } from "@/db/schema";

type Executor = Pick<typeof db, "select" | "insert" | "update">;
export interface TaskReviewScope {
    itemId: string;
    userId: string;
    view: "private" | "org";
}

/** Read review metadata only for the authorized item's owner and view. */
export async function taskReviewState(
    executor: Pick<typeof db, "select">,
    scope: TaskReviewScope,
) {
    const [row] = await executor
        .select({
            skippedAt: itemProcessing.taskReviewSkippedAt,
            changedAt: itemProcessing.taskReviewChangedAt,
        })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, scope.itemId),
                eq(itemProcessing.userId, scope.userId),
                eq(itemProcessing.view, scope.view),
            ),
        )
        .limit(1);
    return { skipped: row?.skippedAt != null, changed: row?.changedAt != null };
}

/** Persist a review draft or skip in the same transaction as its authorized mutation. */
export async function markTaskReviewInTx(
    executor: Pick<typeof db, "execute">,
    scope: TaskReviewScope,
    marker: "changed" | "skipped",
) {
    await writeTaskReviewMarkerInTx(executor, scope, marker);
}

/** A completed review clears both draft markers atomically with its decisions. */
export async function clearTaskReviewInTx(
    executor: Executor,
    scope: TaskReviewScope,
) {
    await executor
        .update(itemProcessing)
        .set({ taskReviewSkippedAt: null, taskReviewChangedAt: null })
        .where(
            and(
                eq(itemProcessing.itemId, scope.itemId),
                eq(itemProcessing.userId, scope.userId),
            ),
        );
}

/** Exclude skipped decisions from the caller-scoped review queue. */
export function taskReviewNotSkipped(
    itemId: SQLWrapper,
    userId: SQLWrapper,
    view: "private" | "org" | SQLWrapper,
) {
    return notExists(
        db
            .select({ id: itemProcessing.itemId })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, itemId),
                    eq(itemProcessing.userId, userId),
                    eq(itemProcessing.view, view),
                    isNotNull(itemProcessing.taskReviewSkippedAt),
                ),
            ),
    );
}

/** Carry the current review with its proposals when sharing or withdrawing an item. */
export async function carryTaskReviewScopeInTx(
    executor: Executor,
    scope: TaskReviewScope,
    targetView: "private" | "org",
): Promise<void> {
    const [source] = await executor
        .select({
            skippedAt: itemProcessing.taskReviewSkippedAt,
            changedAt: itemProcessing.taskReviewChangedAt,
        })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, scope.itemId),
                eq(itemProcessing.userId, scope.userId),
                eq(itemProcessing.view, scope.view),
            ),
        )
        .limit(1);
    if (!source || (!source.skippedAt && !source.changedAt)) return;
    const set = {
        taskReviewSkippedAt: source.skippedAt,
        taskReviewChangedAt: source.changedAt,
    };
    await executor
        .insert(itemProcessing)
        .values({ ...scope, view: targetView, ...set })
        .onConflictDoUpdate({
            target: [itemProcessing.itemId, itemProcessing.view],
            set,
            setWhere: eq(itemProcessing.userId, scope.userId),
        });
}
