import { patchAgendaTaskInput } from "@/lib/meetings/model";
import { meetingRoute } from "@/lib/meetings/route";
import { changeAgendaTask } from "@/lib/meetings/service";
export const PATCH = meetingRoute(async ({ userId, params, request }) =>
    changeAgendaTask(
        userId,
        params.id,
        params.taskId,
        patchAgendaTaskInput.parse(await request.json()),
    ),
);
export const DELETE = meetingRoute(async ({ userId, params }) =>
    changeAgendaTask(userId, params.id, params.taskId, { removed: true }),
);
