import { type AnyColumn, and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { activeShareRecipientExistsCondition } from "@/db/queries/share-recipients";
import {
    chatterItems,
    itemShares,
    meetingAgendas,
    recordingFolders,
} from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";

/** Direct agenda access stays independent of recording, task and evidence visibility. */
export function receivedMeetingCondition(
    userId: string,
    itemId: AnyColumn = chatterItems.id,
) {
    if (!isOrgScopeVisible()) return sql`false`;
    return sql`exists (select 1 from ${itemShares} agenda_share
        inner join ${chatterItems} agenda_item on agenda_item.id = agenda_share.item_id
            and agenda_item.user_id = agenda_share.user_id and agenda_item.kind = 'meeting'
        where agenda_share.item_id = ${itemId} and agenda_share.receiver_user_id = ${userId}
            and agenda_share.folder_share_id is null and agenda_share.state = 'accepted'
            and ${activeShareRecipientExistsCondition(userId)})`;
}

/** Absorption tombstones retain invitations; ordinary deletion does not. */
export function liveShareItemCondition() {
    return or(
        isNull(chatterItems.deletedAt),
        and(
            eq(chatterItems.kind, "meeting"),
            sql`exists (select 1 from ${meetingAgendas} shared_agenda
            where shared_agenda.meeting_item_id = ${chatterItems.id}
              and shared_agenda.user_id = ${chatterItems.userId}
              and shared_agenda.recording_item_id is not null)`,
        ),
    );
}

/** Caller-owned private filing for accepted direct agendas, including absorbed plans. */
export async function receivedMeetingFilings(
    userId: string,
    itemIds: string[],
) {
    if (!isOrgScopeVisible() || !itemIds.length) return [];
    return db
        .select({
            itemId: itemShares.itemId,
            id: recordingFolders.id,
            name: recordingFolders.name,
            userId: recordingFolders.userId,
            parentId: recordingFolders.parentId,
            shareId: itemShares.id,
            version: itemShares.version,
        })
        .from(itemShares)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, itemShares.filingFolderId),
        )
        .where(
            and(
                eq(itemShares.receiverUserId, userId),
                eq(recordingFolders.userId, userId),
                sql`${itemShares.itemId} in (${sql.join(
                    itemIds.map((id) => sql`${id}`),
                    sql`, `,
                )})`,
                eq(itemShares.state, "accepted"),
                activeShareRecipientExistsCondition(userId),
            ),
        );
}

/** Accepted direct agenda receipts, including shares without an extra filing. */
export async function receivedMeetingShares(userId: string, itemIds: string[]) {
    if (!isOrgScopeVisible() || !itemIds.length) return [];
    return db
        .select({
            id: itemShares.id,
            itemId: itemShares.itemId,
            version: itemShares.version,
            filingFolderId: itemShares.filingFolderId,
        })
        .from(itemShares)
        .where(
            and(
                eq(itemShares.receiverUserId, userId),
                eq(itemShares.state, "accepted"),
                sql`${itemShares.itemId} in (${sql.join(
                    itemIds.map((id) => sql`${id}`),
                    sql`, `,
                )})`,
                activeShareRecipientExistsCondition(userId),
            ),
        );
}
