import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agendaTasks } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { meetingRoute } from "@/lib/meetings/route";
import { taskViewerById } from "@/lib/tasks/access";
import { updateTask } from "@/lib/tasks/tasks";
export const PATCH = meetingRoute(async ({ userId, params, request }) => {
    const input = z
        .object({
            version: z.number().int().nonnegative(),
            status: z.enum(["done", "dropped"]),
        })
        .parse(await request.json());
    const { agenda } = await requireMeetingAccess(userId, params.id, "edit");
    const [link] = await db
        .select()
        .from(agendaTasks)
        .where(
            and(
                eq(agendaTasks.agendaId, agenda.id),
                eq(agendaTasks.userId, agenda.userId),
                eq(agendaTasks.taskId, params.taskId),
                isNull(agendaTasks.removedAt),
            ),
        );
    if (!link)
        throw new AppError(ErrorCode.NOT_FOUND, "Agenda task not found", 404);
    const viewer = { ...(await taskViewerById(userId)), includeReceived: true };
    return updateTask(viewer, params.taskId, input);
}, true);
