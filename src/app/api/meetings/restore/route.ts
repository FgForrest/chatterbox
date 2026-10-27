import { restoreMeetings } from "@/lib/meetings/restore";
import { meetingRoute } from "@/lib/meetings/route";

export const POST = meetingRoute(async ({ userId, request }) =>
    restoreMeetings(userId, await request.json()),
);
