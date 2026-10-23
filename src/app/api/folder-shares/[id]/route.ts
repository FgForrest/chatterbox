import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/errors";
import { changeFolderShare } from "@/lib/sharing/folder-shares";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

type Context = { params: Promise<{ id: string }> };
const input = z.object({
    action: z.enum(["accept", "decline", "cancel", "remove", "rename", "move"]),
    version: z.number().int().nonnegative(),
    name: z.string().min(1).max(100).optional(),
    parentId: z.string().min(1).max(256).nullable().optional(),
    sortOrder: z.number().int().min(0).max(2147483647).optional(),
});
export const PATCH = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const parsed = input.safeParse(await readTaskBody(request));
    if (!parsed.success) throw invalid("Invalid folder share action");
    await changeFolderShare(session.user.id, id, parsed.data);
    return NextResponse.json({ success: true });
});
