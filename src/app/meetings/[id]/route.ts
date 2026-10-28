import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    meetingRecordingRedirect,
    requireMeetingAccess,
} from "@/lib/meetings/access";

type Context = { params: Promise<{ id: string }> };

/** A stable meeting link follows absorption and becomes standalone again after detach. */
export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    const access = await requireMeetingAccess(session.user.id, id);
    const { agenda } = access;
    const redirectTo = await meetingRecordingRedirect(session.user.id, access);
    const url = new URL(redirectTo ?? "/dashboard", request.url);
    if (!redirectTo)
        url.searchParams.set("meeting", agenda.meetingItemId ?? agenda.id);
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
});
