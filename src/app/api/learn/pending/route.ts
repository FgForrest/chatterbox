import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { pendingReviewCount } from "@/lib/learn/pending";
import { taskViewer } from "@/lib/tasks/access";
import { recordingsAwaitingTaskReview } from "@/lib/tasks/tasks";

/**
 * How many reviews wait for the caller: the Almanac badge. Learn reviews,
 * and items with proposed tasks or follow-up changes.
 */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const [tasks, learn] = await Promise.all([
        taskViewer(session.user).then(recordingsAwaitingTaskReview),
        isLearnDeploymentAvailable() ? pendingReviewCount(session.user.id) : 0,
    ]);
    return NextResponse.json({ count: learn + tasks.length });
});
