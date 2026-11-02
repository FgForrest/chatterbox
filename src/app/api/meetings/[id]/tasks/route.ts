import { addAgendaTasksInput } from "@/lib/meetings/model";
import { meetingRoute } from "@/lib/meetings/route";
import { addAgendaTasks } from "@/lib/meetings/service";
export const POST = meetingRoute(async ({ userId, params, request }) => {
    const input = addAgendaTasksInput.parse(await request.json());
    await addAgendaTasks(userId, params.id, input.taskIds ?? [input.taskId]);
});
