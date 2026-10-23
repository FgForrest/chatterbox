import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { changePersonShare } from "@/lib/sharing/person-shares";
import { invalid, readTaskBody, readVersion } from "@/lib/tasks/route-helpers";

type Context = { params: Promise<{ id: string }> };

export const PATCH = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const body = await readTaskBody(request);
    const action = body.action;
    if (
        action !== "accept" &&
        action !== "decline" &&
        action !== "cancel" &&
        action !== "remove" &&
        action !== "file"
    )
        throw invalid("Unknown share action");
    if (body.folderId !== undefined && typeof body.folderId !== "string")
        throw invalid("Invalid folder");
    await changePersonShare(session.user.id, id, {
        action,
        version: readVersion(body.version),
        folderId: body.folderId as string | undefined,
    });
    return NextResponse.json({ success: true });
});
