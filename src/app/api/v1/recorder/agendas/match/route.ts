import { z } from "zod";
import { matchRecorderAgendas } from "@/lib/meetings/calendar";
import { meetingDate, meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(
    async ({ userId, url }) => ({
        data: await matchRecorderAgendas(
            userId,
            meetingDate(url.searchParams.get("at"), new Date()),
            url.searchParams.has("meetCode")
                ? z.string().max(64).parse(url.searchParams.get("meetCode"))
                : undefined,
        ),
    }),
    true,
);
