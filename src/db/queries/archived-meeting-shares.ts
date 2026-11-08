import { sql } from "drizzle-orm";
import { itemShares } from "@/db/schema";

/** Owned agendas are archived independently of the recording that absorbed them. */
export function archivedMeetingShareCondition(userId: string) {
    return sql`exists (select 1 from meeting_agendas archive_agenda
        where archive_agenda.meeting_item_id = ${itemShares.itemId}
          and archive_agenda.user_id = ${userId})`;
}
