import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { findMeeting } from "@/db/queries/meetings";
import { taskNoteHasMailSource } from "@/db/queries/task-visibility";
import {
    agendaPoints,
    agendaSuggestions,
    chatterItems,
    recordingTasks,
} from "@/db/schema";

/** Mail provenance is checked even when the referenced source is no longer visible. */
export async function agendaMailDerivedContent(
    userId: string,
    orgUserId: string | null,
    agendaId: string,
) {
    const access = await findMeeting(userId, orgUserId, agendaId);
    if (!access)
        return {
            suggestionIds: new Set<string>(),
            pointIds: new Set<string>(),
        };
    const suggestions = await db
        .select({ id: agendaSuggestions.id, text: agendaSuggestions.text })
        .from(agendaSuggestions)
        .where(
            and(
                eq(agendaSuggestions.agendaId, access.agenda.id),
                eq(agendaSuggestions.userId, access.agenda.userId),
                sql`(exists (select 1 from jsonb_array_elements_text(${agendaSuggestions.sources}->'itemIds') source_item(id)
                    left join ${chatterItems} on ${chatterItems.id} = source_item.id
                    where ${chatterItems.kind} is distinct from 'audio' and ${chatterItems.kind} is distinct from 'meeting')
                or exists (select 1 from jsonb_array_elements_text(${agendaSuggestions.sources}->'taskIds') source_task(id)
                    left join ${recordingTasks} on ${recordingTasks.id} = source_task.id
                    left join ${chatterItems} on ${chatterItems.id} = ${recordingTasks.itemId}
                    where ${recordingTasks.id} is null or ${chatterItems.kind} = 'mail' or ${taskNoteHasMailSource()}))`,
            ),
        );
    const texts = new Set(suggestions.map((suggestion) => suggestion.text));
    const points = suggestions.length
        ? await db
              .select({ id: agendaPoints.id, text: agendaPoints.text })
              .from(agendaPoints)
              .where(
                  and(
                      eq(agendaPoints.agendaId, access.agenda.id),
                      eq(agendaPoints.userId, access.agenda.userId),
                  ),
              )
        : [];
    return {
        suggestionIds: new Set(suggestions.map((suggestion) => suggestion.id)),
        pointIds: new Set(
            points
                .filter((point) => texts.has(point.text))
                .map((point) => point.id),
        ),
    };
}
