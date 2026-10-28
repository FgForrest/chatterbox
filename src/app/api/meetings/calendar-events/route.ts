import { z } from "zod";
import { meetingCalendarEvents } from "@/lib/meetings/calendar";
import { meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(async ({ userId, url }) =>
    meetingCalendarEvents(
        userId,
        z.string().min(1).max(255).parse(url.searchParams.get("folderId")),
    ),
);
