import type { db } from "@/db";
import { taskStatusTransitions } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Status = (typeof taskStatusTransitions.$inferInsert)["toStatus"];

/** Append a creation or actual status change inside the authorized task writer's transaction. */
export async function logTaskStatusInTx(
    tx: Tx,
    taskId: string,
    actorUserId: string | null,
    fromStatus: Status | null,
    toStatus: Status,
    createdAt = new Date(),
): Promise<void> {
    if (fromStatus === toStatus) return;
    await tx
        .insert(taskStatusTransitions)
        .values({ taskId, actorUserId, fromStatus, toStatus, createdAt });
}
