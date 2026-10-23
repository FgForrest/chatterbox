import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/errors";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { restoreArchivedFolderShares } from "@/lib/sharing/restore-folder-shares";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

const input = z.object({
    shares: z
        .array(
            z.object({
                folderId: z.string().min(1).max(256),
                receiverEmail: z.email().max(320),
                state: z.enum(["pending", "accepted", "declined", "removed"]),
            }),
        )
        .max(100),
    folderIds: z
        .record(z.string().min(1).max(256), z.string().min(1).max(256))
        .refine((ids) => Object.keys(ids).length <= 100),
});
export const POST = apiHandler(async (request) => {
    const session = await requirePersonShareSession(request);
    const parsed = input.safeParse(await readTaskBody(request));
    if (!parsed.success) throw invalid("Invalid folder share archive");
    return NextResponse.json(
        await restoreArchivedFolderShares(
            session.user.id,
            parsed.data.shares,
            new Map(Object.entries(parsed.data.folderIds)),
        ),
    );
});
