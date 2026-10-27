import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { requireMeetingAccess } from "@/lib/meetings/access";

type Context = { params: Promise<{ id: string }> };

/** A stable meeting link follows absorption and becomes standalone again after detach. */
export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    const { agenda } = await requireMeetingAccess(session.user.id, id);
    const url = new URL("/dashboard", request.url);
    url.searchParams.set(
        agenda.recordingItemId ? "recording" : "meeting",
        agenda.recordingItemId ?? agenda.meetingItemId ?? agenda.id,
    );
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
});
