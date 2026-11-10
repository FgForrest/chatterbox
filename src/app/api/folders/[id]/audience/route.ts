import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    changeRestrictedAudience,
    listRestrictedAudience,
} from "@/lib/folders/restricted-folders";

type Context = { params: Promise<{ id: string }> };
const add = z.object({ userIds: z.array(z.string().min(1)).max(20) });
const remove = z.object({ userId: z.string().min(1) });

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(await listRestrictedAudience(session.user.id, id));
});

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    const input = add.safeParse(await request.json().catch(() => null));
    if (!input.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    const result = await changeRestrictedAudience(session.user.id, id, {
        addUserIds: input.data.userIds,
    });
    return NextResponse.json({ updated: true, ...result });
});

export const DELETE = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    const input = remove.safeParse(await request.json().catch(() => null));
    if (!input.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    await changeRestrictedAudience(session.user.id, id, {
        removeUserId: input.data.userId,
    });
    return NextResponse.json({ updated: true });
});
