import { NextResponse } from "next/server";
import { requireApiSession, requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    dashboardFolderOrganization,
    listDashboardReceivedShares,
} from "@/lib/folders/dashboard-organization";
import { createFolder, listFolderOrganization } from "@/lib/folders/folders";

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    if (new URL(request.url).searchParams.get("dashboard") === "1") {
        const [organization, receivedShares] = await Promise.all([
            listFolderOrganization(userId),
            listDashboardReceivedShares(userId),
        ]);
        return NextResponse.json(
            dashboardFolderOrganization(organization, receivedShares),
            {
                headers: { "Cache-Control": "private, no-store" },
            },
        );
    }
    return NextResponse.json(await listFolderOrganization(userId));
});

export const POST = apiHandler(async (request: Request) => {
    const { actor, session } = await requireApiSessionActor(request);
    const body = (await request.json().catch(() => null)) as {
        name?: unknown;
        parentId?: unknown;
        restricted?: unknown;
        audienceUserIds?: unknown;
    } | null;
    if (typeof body?.name !== "string" || typeof body.parentId !== "string") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A folder name and parent are required",
            400,
        );
    }

    if (
        (body.restricted !== undefined &&
            typeof body.restricted !== "boolean") ||
        (body.audienceUserIds !== undefined &&
            (!Array.isArray(body.audienceUserIds) ||
                body.audienceUserIds.some((id) => typeof id !== "string")))
    )
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    const folder = await createFolder({
        userId: session.user.id,
        name: body.name,
        parentId: body.parentId,
        restricted: body.restricted === true,
        audienceUserIds: body.audienceUserIds as string[] | undefined,
        canCurate: await actsForOrganization(actor),
    });
    return NextResponse.json({ folder }, { status: 201 });
});
