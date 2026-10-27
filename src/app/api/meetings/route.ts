import { meetingRoute } from "@/lib/meetings/route";
import { listMeetings, prepareMeeting } from "@/lib/meetings/service";
export const GET = meetingRoute(async ({ userId, url }) => ({
    meetings: await listMeetings(userId, {
        folderId: url.searchParams.get("folderId") ?? undefined,
    }),
}));
export const POST = meetingRoute(async ({ userId, request }) =>
    prepareMeeting(userId, await request.json()),
);
