import { z } from "zod";
import { meetingRoute } from "@/lib/meetings/route";
import { addAgendaTask } from "@/lib/meetings/service";
export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = z
        .object({ taskId: z.string().min(1).max(255) })
        .parse(await request.json());
    await addAgendaTask(userId, params.id, input.taskId);
});
