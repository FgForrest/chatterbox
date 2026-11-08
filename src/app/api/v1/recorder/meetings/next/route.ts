import { nextRecorderMeeting } from "@/lib/meetings/next-meeting";
import { meetingRoute } from "@/lib/meetings/route";

export const GET = meetingRoute(
    ({ userId }) => nextRecorderMeeting(userId),
    true,
);
