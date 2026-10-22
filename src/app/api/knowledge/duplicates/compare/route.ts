import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    compareDuplicates,
    joinDuplicates,
} from "@/lib/knowledge/duplicate-comparison";
import { requireDuplicateCurator } from "@/lib/knowledge/duplicates";
import { jsonBody } from "@/lib/knowledge/route-helpers";

const id = z.string().min(1).max(64);
const kind = z.enum(["person", "entity"]);
const pair = z.object({ kind, left: id, right: id });

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireDuplicateCurator(session.user.id);
    const query = pair.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid comparison query",
            400,
        );
    return NextResponse.json(
        await compareDuplicates(
            session.user.id,
            query.data.kind,
            query.data.left,
            query.data.right,
        ),
    );
});

export const POST = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireDuplicateCurator(session.user.id);
    const body = z
        .object({
            kind,
            survivorId: id,
            loserId: id,
            nameSourceId: id,
            version: z.string().length(64),
            factChoices: z.record(z.string().max(64), id),
        })
        .safeParse(await jsonBody(request));
    if (!body.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid merge choices",
            400,
        );
    const { kind: recordKind, survivorId, loserId, ...choices } = body.data;
    await joinDuplicates(
        session.user.id,
        recordKind,
        survivorId,
        loserId,
        choices,
    );
    return NextResponse.json({ survivorId });
});
