import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { recordingFollowUps } from "@/lib/learn/follow-ups";

type IdContext = { params: Promise<{ id: string }> };

/**
 * `{held, pending}`: whether the title, summary and topics wait for the
 * Learn review, and which of the jobs that make them are still to finish.
 * The owner's private view only.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const followUps = await recordingFollowUps(session.user.id, id);
    if (!followUps) {
        throw new AppError(ErrorCode.NOT_FOUND, "Recording not found", 404);
    }
    return NextResponse.json(followUps);
});
