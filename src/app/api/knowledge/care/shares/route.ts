import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import {
    getSharedAdditions,
    undoShareAdditions,
} from "@/lib/knowledge/share-review";

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireCareCurator(session.user.id);
    const query = z
        .object({
            eventId: z.string().min(1).max(64),
            additionOffset: z.coerce
                .number()
                .int()
                .min(0)
                .max(100000)
                .default(0),
        })
        .safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success)
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid share query", 400);
    return NextResponse.json(
        await getSharedAdditions(
            session.user.id,
            query.data.eventId,
            query.data.additionOffset,
        ),
    );
});

export const POST = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireCareCurator(session.user.id);
    const body = z
        .object({
            eventId: z.string().min(1).max(64),
            action: z.enum(["undo", "delete"]),
            additionId: z.string().min(1).max(64).optional(),
        })
        .safeParse(await jsonBody(request));
    if (
        !body.success ||
        (body.data.action === "delete" && !body.data.additionId)
    )
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid share action",
            400,
        );
    return NextResponse.json(
        await undoShareAdditions(
            session.user.id,
            body.data.eventId,
            body.data.action === "delete" ? body.data.additionId : undefined,
        ),
    );
});
