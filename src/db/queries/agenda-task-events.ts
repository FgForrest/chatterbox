import { and, eq } from "drizzle-orm";
import { bumpAgendaIfPresentInTx } from "@/db/queries/agenda-events";
import type { MeetingTx } from "@/db/queries/meetings";
import { agendaTasks, meetingAgendas } from "@/db/schema";

/** Invalidate every stored reference to an already-authorized task without disclosing agendas to its writer. */
export async function publishTaskAgendaEventsInTx(
    tx: MeetingTx,
    taskId: string,
) {
    const rows = await tx
        .select({ id: meetingAgendas.id, userId: meetingAgendas.userId })
        .from(meetingAgendas)
        .innerJoin(
            agendaTasks,
            and(
                eq(agendaTasks.agendaId, meetingAgendas.id),
                eq(agendaTasks.userId, meetingAgendas.userId),
            ),
        )
        .where(eq(agendaTasks.taskId, taskId))
        .orderBy(meetingAgendas.id);
    for (const row of rows) await bumpAgendaIfPresentInTx(tx, row);
}
