import { and, eq, inArray, sql } from "drizzle-orm";
import type { MeetingTx } from "@/db/queries/meetings";
import { agendaPoints, meetingAgendas } from "@/db/schema";
import { encryptJsonField } from "@/lib/encryption/fields";
import {
    type AgendaOutcome,
    mergeAgendaOutcomes,
} from "@/lib/meetings/summary-directive";

export interface AgendaSummaryWrite {
    id: string;
    userId: string;
    version: number;
    outcome: AgendaOutcome | null;
}

/** Lock and recheck the attachment under the recording lock, before a summary writes anything. */
export async function lockSummaryAgenda(
    tx: MeetingTx,
    recordingId: string,
    agenda: AgendaSummaryWrite,
): Promise<boolean> {
    const [current] = await tx
        .select({ version: meetingAgendas.version })
        .from(meetingAgendas)
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
                eq(meetingAgendas.recordingItemId, recordingId),
            ),
        )
        .for("update");
    return current !== undefined;
}

/** Replace encrypted agenda outcomes atomically with the summary that produced them. */
export async function writeSummaryAgenda(
    tx: MeetingTx,
    agenda: AgendaSummaryWrite,
    summaryId: string,
) {
    if (!agenda.outcome) return;
    const pointsWhere = and(
        eq(agendaPoints.agendaId, agenda.id),
        eq(agendaPoints.userId, agenda.userId),
    );
    const points = await tx
        .select({ id: agendaPoints.id })
        .from(agendaPoints)
        .where(pointsWhere);
    const outcome = mergeAgendaOutcomes(
        [agenda.outcome],
        points.map((point) => point.id),
    );
    await tx
        .update(agendaPoints)
        .set({ summaryOutcome: outcome ? "not_covered" : null })
        .where(pointsWhere);
    if (outcome?.covered.length)
        await tx
            .update(agendaPoints)
            .set({ summaryOutcome: "covered" })
            .where(and(pointsWhere, inArray(agendaPoints.id, outcome.covered)));
    await tx
        .update(meetingAgendas)
        .set({
            outcomeSummaryId: summaryId,
            outcomeUnplanned: encryptJsonField(outcome?.unplanned ?? []),
            version: sql`${meetingAgendas.version} + 1`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
            ),
        );
}
