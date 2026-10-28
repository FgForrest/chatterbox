import { z } from "zod";
import { requestTimeZone } from "@/lib/i18n/user-time-zone";
import { exportMeetingMarkdown } from "@/lib/meetings/export";
import { meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(async ({ userId, params, url, request }) => {
    const result = await exportMeetingMarkdown(
        userId,
        params.id,
        z.enum(["en", "cs-CZ"]).parse(url.searchParams.get("locale") ?? "en"),
        url.searchParams.get("includeTasks") !== "false",
        await requestTimeZone(userId, request),
    );
    return new Response(result.markdown, {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            "Cache-Control": "private, no-store",
        },
    });
});
