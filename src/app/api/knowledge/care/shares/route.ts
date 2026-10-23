import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import {
    listSharedAdditions,
    reviewShare,
    undoShareAdditions,
} from "@/lib/knowledge/share-review";

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireCareCurator(session.user.id);
    const query = z
        .object({
            offset: z.coerce.number().int().min(0).max(10000).default(0),
            eventId: z.string().min(1).max(64).optional(),
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
        await listSharedAdditions(
            session.user.id,
            query.data.offset,
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
            action: z.enum(["review", "undo", "delete"]),
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
    if (body.data.action === "review") {
        await reviewShare(session.user.id, body.data.eventId);
        return NextResponse.json({ reviewed: true });
    }
    return NextResponse.json(
        await undoShareAdditions(
            session.user.id,
            body.data.eventId,
            body.data.action === "delete" ? body.data.additionId : undefined,
        ),
    );
});
