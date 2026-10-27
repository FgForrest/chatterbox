import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { findMeeting } from "@/db/queries/meetings";
import { taskNoteHasMailSource } from "@/db/queries/task-visibility";
import {
    agendaPoints,
    agendaSuggestions,
    chatterItems,
    recordingTasks,
} from "@/db/schema";

function hasMailSource(sources: AnyPgColumn) {
    return sql`(exists (select 1 from jsonb_array_elements_text(${sources}->'itemIds') source_item(id)
                    left join ${chatterItems} on ${chatterItems.id} = source_item.id
                    where ${chatterItems.kind} is distinct from 'audio' and ${chatterItems.kind} is distinct from 'meeting')
                or exists (select 1 from jsonb_array_elements_text(${sources}->'taskIds') source_task(id)
                    left join ${recordingTasks} on ${recordingTasks.id} = source_task.id
                    left join ${chatterItems} on ${chatterItems.id} = ${recordingTasks.itemId}
                    where ${recordingTasks.id} is null or ${chatterItems.kind} = 'mail' or ${taskNoteHasMailSource()}))`;
}

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
    const [suggestions, points] = await Promise.all([
        db
            .select({ id: agendaSuggestions.id })
            .from(agendaSuggestions)
            .where(
                and(
                    eq(agendaSuggestions.agendaId, access.agenda.id),
                    eq(agendaSuggestions.userId, access.agenda.userId),
                    hasMailSource(agendaSuggestions.sources),
                ),
            ),
        db
            .select({ id: agendaPoints.id })
            .from(agendaPoints)
            .where(
                and(
                    eq(agendaPoints.agendaId, access.agenda.id),
                    eq(agendaPoints.userId, access.agenda.userId),
                    hasMailSource(agendaPoints.sources),
                ),
            ),
    ]);
    return {
        suggestionIds: new Set(suggestions.map((suggestion) => suggestion.id)),
        pointIds: new Set(points.map((point) => point.id)),
    };
}
