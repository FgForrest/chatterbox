import { nextMeeting } from "@/lib/meetings/calendar";
import { meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(async ({ userId, params }) =>
    nextMeeting(userId, params.id),
);
