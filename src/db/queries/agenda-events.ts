import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import type { MeetingTx } from "@/db/queries/meetings";
import { agendaEventStreams, meetingAgendas, users } from "@/db/schema";

import { AGENDA_EVENT_CHANNEL } from "@/lib/meetings/event-protocol";
export const MAX_AGENDA_STREAMS_PER_USER = 6;
const LEASE_MS = 75_000;

/** Publish only IDs and a cursor; PostgreSQL delivers it only if the transaction commits. */
export async function publishAgendaEventInTx(
    tx: Pick<MeetingTx, "execute">,
    agendaId: string,
    cursor: string,
) {
    await tx.execute(
        sql`select pg_notify(${AGENDA_EVENT_CHANNEL}, ${JSON.stringify({ agendaId, cursor })})`,
    );
}

/** Atomically advance the durable cursor and notify every listening process. */
export async function bumpAgendaInTx(
    tx: MeetingTx,
    agenda: { id: string; userId: string },
) {
    const [row] = await tx
        .update(meetingAgendas)
        .set({
            version: sql`${meetingAgendas.version} + 1`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(meetingAgendas.id, agenda.id),
                eq(meetingAgendas.userId, agenda.userId),
            ),
        )
        .returning({ version: meetingAgendas.version });
    if (!row) throw new Error("Agenda update returned no row");
    await publishAgendaEventInTx(tx, agenda.id, String(row.version));
}

/** Lease stream capacity under a user row lock so app processes share the same cap. */
export async function claimAgendaStream(
    userId: string,
): Promise<string | null> {
    return db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
        const now = new Date();
        await tx
            .delete(agendaEventStreams)
            .where(
                and(
                    eq(agendaEventStreams.userId, userId),
                    sql`${agendaEventStreams.expiresAt} <= ${now.toISOString()}::timestamp`,
                ),
            );
        const leases = await tx
            .select({ id: agendaEventStreams.id })
            .from(agendaEventStreams)
            .where(
                and(
                    eq(agendaEventStreams.userId, userId),
                    gt(agendaEventStreams.expiresAt, now),
                ),
            );
        if (leases.length >= MAX_AGENDA_STREAMS_PER_USER) return null;
        const [lease] = await tx
            .insert(agendaEventStreams)
            .values({ userId, expiresAt: new Date(now.getTime() + LEASE_MS) })
            .returning();
        return lease.id;
    });
}

/** Extend only a live stream lease; an expired lease cannot reclaim capacity. */
export async function renewAgendaStream(
    userId: string,
    id: string,
): Promise<boolean> {
    const now = new Date();
    const rows = await db
        .update(agendaEventStreams)
        .set({ expiresAt: new Date(now.getTime() + LEASE_MS) })
        .where(
            and(
                eq(agendaEventStreams.userId, userId),
                eq(agendaEventStreams.id, id),
                gt(agendaEventStreams.expiresAt, now),
            ),
        )
        .returning({ id: agendaEventStreams.id });
    return rows.length > 0;
}

/** Release capacity on disconnect; expiry also recovers leases after process failure. */
export async function releaseAgendaStream(userId: string, id: string) {
    await db
        .delete(agendaEventStreams)
        .where(
            and(
                eq(agendaEventStreams.userId, userId),
                eq(agendaEventStreams.id, id),
            ),
        );
}
