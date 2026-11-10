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
    const predicate = sql`(exists (select 1 from jsonb_array_elements_text(${sources}->'itemIds') source_item(id)
                    left join ${chatterItems} on ${chatterItems.id} = source_item.id
                    where ${chatterItems.kind} is distinct from 'audio' and ${chatterItems.kind} is distinct from 'meeting')
                or exists (select 1 from jsonb_array_elements_text(${sources}->'taskIds') source_task(id)
                    left join ${recordingTasks} on ${recordingTasks.id} = source_task.id
                    left join ${chatterItems} on ${chatterItems.id} = ${recordingTasks.itemId}
                    where ${recordingTasks.id} is null or ${chatterItems.kind} = 'mail' or ${taskNoteHasMailSource()}))`;
    // Nest the predicate so Drizzle preserves correlated column qualifiers in SELECT fields.
    return sql<boolean>`${predicate}`;
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
            allSuggestionIds: new Set<string>(),
            allPointIds: new Set<string>(),
        };
    const [suggestions, points] = await Promise.all([
        db
            .select({
                id: agendaSuggestions.id,
                mailSourced: hasMailSource(agendaSuggestions.sources),
            })
            .from(agendaSuggestions)
            .where(
                and(
                    eq(agendaSuggestions.agendaId, access.agenda.id),
                    eq(agendaSuggestions.userId, access.agenda.userId),
                ),
            ),
        db
            .select({
                id: agendaPoints.id,
                mailSourced: hasMailSource(agendaPoints.sources),
            })
            .from(agendaPoints)
            .where(
                and(
                    eq(agendaPoints.agendaId, access.agenda.id),
                    eq(agendaPoints.userId, access.agenda.userId),
                ),
            ),
    ]);
    return {
        suggestionIds: new Set(
            suggestions
                .filter((suggestion) => suggestion.mailSourced)
                .map((suggestion) => suggestion.id),
        ),
        pointIds: new Set(
            points
                .filter((point) => point.mailSourced)
                .map((point) => point.id),
        ),
        allSuggestionIds: new Set(
            suggestions.map((suggestion) => suggestion.id),
        ),
        allPointIds: new Set(points.map((point) => point.id)),
    };
}
