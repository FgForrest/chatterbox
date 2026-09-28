import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { pendingReviewCount } from "@/lib/learn/pending";
import { isOrgAccount } from "@/lib/org/config";

/** How many Learn reviews wait for the caller: the People badge. */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    if (!isLearnDeploymentAvailable()) return NextResponse.json({ count: 0 });
    return NextResponse.json({
        count: await pendingReviewCount(
            session.user.id,
            await isOrgAccount(session.user.id),
        ),
    });
});
