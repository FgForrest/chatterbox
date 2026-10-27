import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { chatterItems, meetingAgendas, recordings } from "@/db/schema";
import { meetingVisibility } from "./meetings";

/** Presence on an already authorized recording row, using the unique recording index. */
export function recordingHasAgenda() {
    return sql<boolean>`exists (select 1 from ${meetingAgendas} where ${meetingAgendas.recordingItemId} = ${recordings.id})`;
}

/** Count owner-visible overlapping plans without fetching their content or calling Calendar. */
export function recordingAgendaCandidateCount(
    userId: string,
    orgUserId: string | null,
) {
    const candidateItem = alias(chatterItems, "agenda_candidate_item");
    return sql<number>`(select count(*)::int from ${meetingAgendas}
        inner join ${chatterItems} as "agenda_candidate_item" on ${candidateItem.id} = ${meetingAgendas.meetingItemId} and ${candidateItem.userId} = ${meetingAgendas.userId}
        where ${meetingAgendas.recordingItemId} is null and ${meetingAgendas.timeSet}
          and ${recordings.endTime} > ${chatterItems.occurredAt}
          and ${meetingVisibility(userId, orgUserId, candidateItem)}
          and ${meetingAgendas.plannedStart} < ${recordings.endTime}
          and coalesce(${meetingAgendas.plannedEnd}, ${meetingAgendas.plannedStart} + interval '2 hours') > ${chatterItems.occurredAt}
          and (least(${recordings.endTime}, coalesce(${meetingAgendas.plannedEnd}, ${meetingAgendas.plannedStart} + interval '2 hours')) - greatest(${chatterItems.occurredAt}, ${meetingAgendas.plannedStart}))
            >= least(${recordings.endTime} - ${chatterItems.occurredAt}, coalesce(${meetingAgendas.plannedEnd}, ${meetingAgendas.plannedStart} + interval '2 hours') - ${meetingAgendas.plannedStart}) / 2)`;
}

/** Presence fields for a recording already authorized by the route's view check. */
export async function loadRecordingAgendaPresence(input: {
    itemId: string;
    ownerUserId: string;
    viewerUserId: string;
    orgUserId: string | null;
    includeCandidates: boolean;
}) {
    const [row] = await db
        .select({
            hasAgenda: recordingHasAgenda(),
            agendaCandidateCount: input.includeCandidates
                ? recordingAgendaCandidateCount(
                      input.viewerUserId,
                      input.orgUserId,
                  )
                : sql<number>`0`,
        })
        .from(recordings)
        .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
        .where(
            and(
                eq(recordings.id, input.itemId),
                eq(recordings.userId, input.ownerUserId),
            ),
        )
        .limit(1);
    return row ?? { hasAgenda: false, agendaCandidateCount: 0 };
}
