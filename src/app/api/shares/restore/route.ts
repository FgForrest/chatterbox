import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/errors";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { restoreArchivedItemShares } from "@/lib/sharing/restore-shares";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

const restoreInput = z.object({
    shares: z
        .array(
            z.object({
                itemId: z.string().min(1).max(256),
                receiverEmail: z.email().max(320),
                state: z.enum(["pending", "accepted", "declined", "removed"]),
            }),
        )
        .max(100),
    itemIds: z.record(z.string().min(1).max(256), z.string().min(1).max(256)),
});

export const POST = apiHandler(async (request) => {
    const session = await requirePersonShareSession(request);
    const parsed = restoreInput.safeParse(await readTaskBody(request));
    if (!parsed.success) throw invalid("Invalid share archive");
    return NextResponse.json(
        await restoreArchivedItemShares(
            session.user.id,
            parsed.data.shares,
            new Map(Object.entries(parsed.data.itemIds)),
        ),
    );
});
