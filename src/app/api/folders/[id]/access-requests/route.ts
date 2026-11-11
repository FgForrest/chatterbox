import { NextResponse } from "next/server";
import { requireApiSessionActor } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    cancelRestrictedFolderAccessRequest,
    listRestrictedFolderAccessRequests,
    requestRestrictedFolderAccess,
} from "@/lib/folders/access-requests";
import { consumePersonShareRateLimit } from "@/lib/sharing/person-share-routes";

type Context = { params: Promise<{ id: string }> };

async function caller(request: Request) {
    const { session, actor } = await requireApiSessionActor(request);
    if (actor.kind === "service")
        throw new AppError(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN, 403);
    await consumePersonShareRateLimit(request, session.user.id);
    return session.user.id;
}

export const POST = apiHandler<Context>(async (request, context) => {
    const userId = await caller(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(await requestRestrictedFolderAccess(userId, id));
});
export const DELETE = apiHandler<Context>(async (request, context) => {
    const userId = await caller(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(
        await cancelRestrictedFolderAccessRequest(userId, id),
    );
});
export const GET = apiHandler<Context>(async (request, context) => {
    const userId = await caller(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(
        await listRestrictedFolderAccessRequests(userId, id),
    );
});
