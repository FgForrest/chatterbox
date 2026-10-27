import { z } from "zod";
import { exportMeetingMarkdown } from "@/lib/meetings/export";
import { meetingRoute } from "@/lib/meetings/route";
export const GET = meetingRoute(async ({ userId, params, url }) => {
    const result = await exportMeetingMarkdown(
        userId,
        params.id,
        z.enum(["en", "cs-CZ"]).parse(url.searchParams.get("locale") ?? "en"),
    );
    return new Response(result.markdown, {
        headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            "Cache-Control": "private, no-store",
        },
    });
});
