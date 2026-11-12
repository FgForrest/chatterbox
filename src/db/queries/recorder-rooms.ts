import { and, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { bumpAgendaIfPresentInTx } from "@/db/queries/agenda-events";
import { meetingVisibility } from "@/db/queries/meetings";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import {
    chatterItems,
    itemShares,
    meetingAgendas,
    recorderRoomPresence,
    recordingSessions,
    users,
} from "@/db/schema";
import type { MeetingViewer } from "@/lib/meetings/access";

export const ROOM_PRESENCE_TTL_MS = 180_000;
export const ROOM_WRITE_INTERVAL_MS = 20_000;

function freshSession(at: Date) {
    return and(
        inArray(recordingSessions.status, ["open", "completing"]),
        gt(recordingSessions.startedAt, new Date(at.getTime() - 12 * 3600000)),
        lte(recordingSessions.startedAt, at),
    );
}

function roomBinding(roomKey: string, at: Date) {
    return sql`(
        exists (select 1 from ${recordingSessions}
            where ${recordingSessions.metadata}->>'roomKey' = ${roomKey}
            and ${recordingSessions.metadata}->>'liveAgendaId' = ${meetingAgendas.id}
            and ${freshSession(at)})
        or exists (select 1 from ${recorderRoomPresence}
            where ${recorderRoomPresence.roomKey} = ${roomKey}
            and ${recorderRoomPresence.agendaId} = ${meetingAgendas.id}
            and ${recorderRoomPresence.seenAt} > ${new Date(at.getTime() - ROOM_PRESENCE_TTL_MS).toISOString()}::timestamp)
    )`;
}

/** A room code grants only a restricted boolean; agenda IDs require the caller's live visibility. */
export async function queryRecorderRoom(
    viewer: MeetingViewer,
    roomKey: string,
    at = new Date(),
) {
    const visible = meetingVisibility(
        viewer.userId,
        viewer.orgUserId,
        chatterItems,
        viewer.curator,
    );
    const rows = await db
        .select({
            id: sql<
                string | null
            >`case when ${visible} then ${meetingAgendas.id} else null end`,
        })
        .from(meetingAgendas)
        .innerJoin(
            chatterItems,
            eq(chatterItems.id, meetingAgendas.meetingItemId),
        )
        .where(
            and(
                isNull(meetingAgendas.recordingItemId),
                isNull(chatterItems.deletedAt),
                roomBinding(roomKey, at),
            ),
        );
    return {
        ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
        restricted: rows.some((row) => row.id === null),
    };
}

/** Only the receiver's pending agenda invitations may cross the room visibility boundary. */
export async function queryRoomInvitationIds(
    viewer: MeetingViewer,
    roomKey: string,
    at = new Date(),
) {
    return db
        .select({
            id: itemShares.id,
            agendaId: meetingAgendas.id,
            end: meetingAgendas.plannedEnd,
            sharerName: users.name,
        })
        .from(itemShares)
        .innerJoin(
            meetingAgendas,
            and(
                eq(meetingAgendas.meetingItemId, itemShares.itemId),
                eq(meetingAgendas.userId, itemShares.userId),
            ),
        )
        .innerJoin(
            chatterItems,
            eq(chatterItems.id, meetingAgendas.meetingItemId),
        )
        .innerJoin(users, eq(users.id, itemShares.userId))
        .where(
            and(
                eq(itemShares.receiverUserId, viewer.userId),
                eq(itemShares.state, "pending"),
                isNull(itemShares.folderShareId),
                isNull(meetingAgendas.recordingItemId),
                isNull(chatterItems.deletedAt),
                roomBinding(roomKey, at),
            ),
        );
}

/** Serialize presence refreshes per user, bounding writes across rooms and application processes. */
export async function refreshRecorderPresence(
    userId: string,
    roomKey: string,
    agendaId: string | null,
    at = new Date(),
) {
    return db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
        const [recent] = await tx
            .select({ writtenAt: recorderRoomPresence.writtenAt })
            .from(recorderRoomPresence)
            .where(eq(recorderRoomPresence.userId, userId))
            .orderBy(desc(recorderRoomPresence.writtenAt))
            .limit(1);
        const retryAfterMs = recent
            ? ROOM_WRITE_INTERVAL_MS -
              (at.getTime() - recent.writtenAt.getTime())
            : 0;
        if (retryAfterMs > 0) return { retryAfterMs };
        await tx
            .insert(recorderRoomPresence)
            .values({ userId, roomKey, agendaId, seenAt: at, writtenAt: at })
            .onConflictDoUpdate({
                target: [
                    recorderRoomPresence.userId,
                    recorderRoomPresence.roomKey,
                ],
                set: { agendaId, seenAt: at, writtenAt: at },
                setWhere: eq(recorderRoomPresence.userId, userId),
            });
        return { retryAfterMs: 0 };
    });
}

/** Leaving immediately hides the caller's presence while preserving the per-user write cap. */
export async function removeRecorderPresence(userId: string, roomKey: string) {
    await db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");
        await tx
            .update(recorderRoomPresence)
            .set({ seenAt: new Date(0), agendaId: null })
            .where(
                and(
                    eq(recorderRoomPresence.userId, userId),
                    eq(recorderRoomPresence.roomKey, roomKey),
                ),
            );
    });
}

/** Active room members for an owner-authorized agenda; the service checks each member's live access. */
export async function queryRoomPeople(
    viewer: MeetingViewer,
    agendaId: string,
    roomKeys: string[],
    at = new Date(),
) {
    if (!roomKeys.length) return [];
    const rows = await db
        .selectDistinct({
            id: users.id,
            name: users.name,
            pending: sql<boolean>`exists (select 1 from ${itemShares} where ${itemShares.userId} = ${viewer.userId}
            and ${itemShares.itemId} = ${meetingAgendas.meetingItemId} and ${itemShares.receiverUserId} = ${users.id}
            and ${itemShares.folderShareId} is null and ${itemShares.state} = 'pending')`,
        })
        .from(recorderRoomPresence)
        .innerJoin(users, eq(users.id, recorderRoomPresence.userId))
        .innerJoin(
            meetingAgendas,
            and(
                eq(meetingAgendas.id, agendaId),
                eq(meetingAgendas.userId, viewer.userId),
            ),
        )
        .innerJoin(
            chatterItems,
            eq(chatterItems.id, meetingAgendas.meetingItemId),
        )
        .where(
            and(
                inArray(recorderRoomPresence.roomKey, roomKeys),
                gt(
                    recorderRoomPresence.seenAt,
                    new Date(at.getTime() - ROOM_PRESENCE_TTL_MS),
                ),
                ne(users.id, viewer.userId),
                activeShareRecipientCondition(),
                isNull(chatterItems.deletedAt),
                isNull(meetingAgendas.recordingItemId),
            ),
        )
        .orderBy(users.id);
    return rows;
}

/** Publish share changes for an agenda only after its item's sharing transaction has committed. */
export async function notifySharedAgenda(userId: string, itemId: string) {
    await db.transaction(async (tx) => {
        const [agenda] = await tx
            .select({ id: meetingAgendas.id, userId: meetingAgendas.userId })
            .from(meetingAgendas)
            .where(
                and(
                    eq(meetingAgendas.meetingItemId, itemId),
                    eq(meetingAgendas.userId, userId),
                ),
            )
            .for("update");
        if (agenda) await bumpAgendaIfPresentInTx(tx, agenda);
    });
}

/** A receiver's response invalidates only the agenda named by their own invitation. */
export async function notifyRecorderInvitation(
    userId: string,
    shareId: string,
) {
    const [share] = await db
        .select({ ownerId: itemShares.userId, itemId: itemShares.itemId })
        .from(itemShares)
        .where(
            and(
                eq(itemShares.id, shareId),
                eq(itemShares.receiverUserId, userId),
            ),
        );
    if (share) await notifySharedAgenda(share.ownerId, share.itemId);
}

/** Delete expired room metadata in bounded housekeeping batches. */
export async function pruneRecorderRoomPresence(
    limit: number,
    at = new Date(),
) {
    const rows = await db.execute(sql`with stale as (
        select user_id, room_key from recorder_room_presence where seen_at <= ${new Date(at.getTime() - ROOM_PRESENCE_TTL_MS).toISOString()}::timestamp
        and written_at <= ${new Date(at.getTime() - ROOM_WRITE_INTERVAL_MS).toISOString()}::timestamp
        order by seen_at limit ${limit} for update skip locked
    ) delete from recorder_room_presence p using stale s where p.user_id = s.user_id and p.room_key = s.room_key returning p.user_id`);
    return rows.length;
}
