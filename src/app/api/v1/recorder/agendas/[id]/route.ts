import { meetingRoute } from "@/lib/meetings/route";
import { getMeeting } from "@/lib/meetings/service";
export const GET = meetingRoute(
    async ({ userId, params }) => getMeeting(userId, params.id),
    true,
);
