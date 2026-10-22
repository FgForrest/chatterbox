import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    dismissDuplicate,
    listDuplicateCandidates,
    requireDuplicateCurator,
} from "@/lib/knowledge/duplicates";
import { jsonBody } from "@/lib/knowledge/route-helpers";

const pair = z.object({
    kind: z.enum(["person", "entity"]),
    left: z.string().min(1).max(64),
    right: z.string().min(1).max(64),
});

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireDuplicateCurator(session.user.id);
    const params = new URL(request.url).searchParams;
    const query = z
        .object({
            kind: z.enum(["person", "entity"]).optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            cursor: z.string().max(512).optional(),
            sourceId: z.string().min(1).max(64).optional(),
        })
        .safeParse(Object.fromEntries(params));
    if (!query.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid duplicate query",
            400,
        );
    return NextResponse.json(
        await listDuplicateCandidates(session.user.id, query.data),
    );
});

export const POST = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireDuplicateCurator(session.user.id);
    const body = pair.safeParse(await jsonBody(request));
    if (!body.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid duplicate pair",
            400,
        );
    await dismissDuplicate(
        session.user.id,
        body.data.kind,
        body.data.left,
        body.data.right,
    );
    return NextResponse.json({ dismissed: true });
});
