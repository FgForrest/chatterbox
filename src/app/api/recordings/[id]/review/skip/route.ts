import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { skipFailedLearn } from "@/lib/learn/review";
import { requireLearnAccess } from "@/lib/sharing/learn-access";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await requireLearnAccess(request, id);
    const read = await readBoundedJson(request, 1024);
    if (read.tooLarge)
        throw new AppError(ErrorCode.INVALID_INPUT, "Request too large", 413);
    const body = read.body as { runId?: unknown } | null;
    if (typeof body?.runId !== "string" || !body.runId)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A Learn run is required",
            400,
        );
    await skipFailedLearn(access, actorUserId, body.runId);
    return NextResponse.json({ changed: true });
});
