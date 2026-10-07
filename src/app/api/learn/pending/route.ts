import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { pendingReviewCount } from "@/lib/learn/pending";
import { isOrgAccount } from "@/lib/org/config";
import { taskViewer } from "@/lib/tasks/access";
import { recordingsAwaitingTaskReview } from "@/lib/tasks/tasks";

/**
 * How many reviews wait for the caller: the Almanac badge. Learn reviews,
 * and recordings with proposed tasks.
 */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const tasks = await recordingsAwaitingTaskReview(
        await taskViewer({ id: session.user.id, email: session.user.email }),
    );
    const learn = isLearnDeploymentAvailable()
        ? await pendingReviewCount(
              session.user.id,
              await isOrgAccount(session.user.id),
          )
        : 0;
    return NextResponse.json({ count: learn + tasks.length });
});
