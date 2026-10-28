import { z } from "zod";
import { requestTimeZone } from "@/lib/i18n/user-time-zone";
import { exportMeetingCalendar } from "@/lib/meetings/export";
import { meetingRoute } from "@/lib/meetings/route";
export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = z
        .object({
            includeTasks: z.boolean().default(false),
            locale: z.enum(["en", "cs-CZ"]).default("en"),
        })
        .parse(await request.json());
    return exportMeetingCalendar(
        userId,
        params.id,
        input.includeTasks,
        input.locale,
        await requestTimeZone(userId, request),
    );
});
