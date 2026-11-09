import {
    addAgendaTasksInput,
    reorderAgendaTasksInput,
} from "@/lib/meetings/model";
import { meetingRoute } from "@/lib/meetings/route";
import { addAgendaTasks, reorderAgendaTasks } from "@/lib/meetings/service";
export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = addAgendaTasksInput.parse(await request.json());
    await addAgendaTasks(userId, params.id, input.taskIds ?? [input.taskId]);
});

export const PATCH = meetingRoute(async ({ userId, params, request }) => {
    await reorderAgendaTasks(
        userId,
        params.id,
        reorderAgendaTasksInput.parse(await request.json()),
    );
});
