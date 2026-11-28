import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingSessions } from "@/db/schema";

type LeaseSession = {
    userId: string;
    apiKeyId: string;
    sessionId: string;
    revision: number;
};

function openLease(session: LeaseSession) {
    return and(
        eq(recordingSessions.id, session.sessionId),
        eq(recordingSessions.userId, session.userId),
        eq(recordingSessions.apiKeyId, session.apiKeyId),
        eq(recordingSessions.status, "open"),
        isNull(recordingSessions.leaseEndedAt),
    );
}

/** Move or refresh an open capture's lease without accepting an older room revision. */
export async function renewRecordingSessionLease(
    session: LeaseSession,
    roomKey: string | null,
) {
    const [updated] = await db
        .update(recordingSessions)
        .set({
            leaseRevision: session.revision,
            liveRoomKey: roomKey,
            liveUntil: sql`now() + interval '60 seconds'`,
            updatedAt: sql`now() at time zone 'UTC'`,
        })
        .where(
            and(
                openLease(session),
                or(
                    lt(recordingSessions.leaseRevision, session.revision),
                    and(
                        eq(recordingSessions.leaseRevision, session.revision),
                        sql`${recordingSessions.liveRoomKey} is not distinct from ${roomKey}`,
                    ),
                ),
            ),
        )
        .returning({ id: recordingSessions.id });
    return Boolean(updated);
}

/** End an open capture's lease permanently with a newer revision. */
export async function endRecordingSessionLease(session: LeaseSession) {
    const [updated] = await db
        .update(recordingSessions)
        .set({
            leaseRevision: session.revision,
            leaseEndedAt: sql`now()`,
            liveRoomKey: null,
            liveUntil: null,
        })
        .where(
            and(
                openLease(session),
                lt(recordingSessions.leaseRevision, session.revision),
            ),
        )
        .returning({ id: recordingSessions.id });
    return Boolean(updated);
}
