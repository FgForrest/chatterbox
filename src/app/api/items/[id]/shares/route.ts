import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import {
    inviteToItem,
    listItemFolderAudience,
    listItemShares,
} from "@/lib/sharing/person-shares";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const [shares, folderAudience] = await Promise.all([
        listItemShares(session.user.id, id),
        listItemFolderAudience(session.user.id, id),
    ]);
    return NextResponse.json({
        shares,
        folderAudience,
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
