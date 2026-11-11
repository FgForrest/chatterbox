import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    changeFolderRestriction,
    previewFolderRestriction,
} from "@/lib/folders/restricted-folders";

type Context = { params: Promise<{ id: string }> };
const body = z.object({
    audienceUserIds: z.array(z.string().min(1)).max(20).default([]),
});

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(
        await previewFolderRestriction(session.user.id, id),
    );
});

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    const input = body.safeParse(await request.json().catch(() => null));
    if (!input.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    return NextResponse.json(
        await changeFolderRestriction(
            session.user.id,
            id,
            "restrict",
            input.data.audienceUserIds,
        ),
    );
});
