import { z } from "zod";
import { meetingCalendarEvents } from "@/lib/meetings/calendar";
import { meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(async ({ userId, url }) => {
    const agendaId = z
        .string()
        .min(1)
        .max(255)
        .optional()
        .parse(url.searchParams.get("agendaId") ?? undefined);
    return meetingCalendarEvents(
        userId,
        agendaId
            ? []
            : z
                  .array(z.string().min(1).max(255))
                  .max(100)
                  .parse(url.searchParams.getAll("folderId")),
        agendaId,
    );
});
