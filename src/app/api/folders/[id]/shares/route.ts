import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/errors";
import { inviteToFolder, listFolderShares } from "@/lib/sharing/folder-shares";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

type Context = { params: Promise<{ id: string }> };
export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json({
        shares: await listFolderShares(session.user.id, id),
    });
});
export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const parsed = z
        .object({
            receiverIds: z.array(z.string().min(1).max(256)).min(1).max(20),
        })
        .safeParse(await readTaskBody(request));
    if (!parsed.success) throw invalid("Choose colleagues");
    return NextResponse.json({
        shares: await inviteToFolder(
            session.user.id,
            id,
            parsed.data.receiverIds,
        ),
    });
});
