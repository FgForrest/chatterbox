import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    changeFolderRestriction,
    previewFolderLift,
} from "@/lib/folders/restricted-folders";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(await previewFolderLift(session.user.id, id));
});

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(
        await changeFolderRestriction(session.user.id, id, "lift"),
    );
});
