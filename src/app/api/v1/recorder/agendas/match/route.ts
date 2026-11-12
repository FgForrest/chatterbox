import { after } from "next/server";
import { z } from "zod";
import { matchRecorderRoom } from "@/lib/meetings/rooms";
import { meetingDate, meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(
    async ({ userId, url }) =>
        matchRecorderRoom(
            userId,
            meetingDate(url.searchParams.get("at"), new Date()),
            url.searchParams.has("meetCode")
                ? z.string().max(64).parse(url.searchParams.get("meetCode"))
                : undefined,
            (refresh) => after(refresh),
        ),
    true,
);
