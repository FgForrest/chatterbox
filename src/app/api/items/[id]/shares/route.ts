import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { inviteToItem, listItemShares } from "@/lib/sharing/person-shares";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json({
        shares: await listItemShares(session.user.id, id),
    });
});

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const body = await readTaskBody(request);
    if (
        !Array.isArray(body.receiverIds) ||
        !body.receiverIds.every(
            (id): id is string =>
                typeof id === "string" && id.length > 0 && id.length < 256,
        )
    )
        throw invalid("receiverIds is required");
    return NextResponse.json({
        shares: await inviteToItem(session.user.id, id, body.receiverIds),
    });
});
