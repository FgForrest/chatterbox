import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import { olderTasks } from "@/lib/meetings/service";
export const GET = meetingRoute(async ({ userId, params, url }) => ({
    tasks: await olderTasks(
        userId,
        params.id,
        z
            .enum(["invited", "all"])
            .parse(url.searchParams.get("scope") ?? "invited"),
    ),
}));
