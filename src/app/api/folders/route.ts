import { NextResponse } from "next/server";
import { requireApiSession, requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { createFolder, listFolderOrganization } from "@/lib/folders/folders";

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    return NextResponse.json(await listFolderOrganization(session.user.id));
});

export const POST = apiHandler(async (request: Request) => {
    const { actor, session } = await requireApiSessionActor(request);
    const body = (await request.json().catch(() => null)) as {
        name?: unknown;
        parentId?: unknown;
    } | null;
    if (typeof body?.name !== "string" || typeof body.parentId !== "string") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A folder name and parent are required",
            400,
        );
    }

    const folder = await createFolder({
        userId: session.user.id,
        name: body.name,
        parentId: body.parentId,
        canCurate: await actsForOrganization(actor),
    });
    return NextResponse.json({ folder }, { status: 201 });
});
