import { type AnyColumn, eq, or, sql } from "drizzle-orm";
import { meetingAgendas, recordingFolderAssignments } from "@/db/schema";

/** A folder's ordinary owner content, plus an explicitly attached recording of its author's meeting. */
export function folderItemOwnerCondition(
    folderOwner: AnyColumn,
    itemOwner: AnyColumn,
    folderId: AnyColumn,
    itemId: AnyColumn,
) {
    return or(
        eq(itemOwner, folderOwner),
        sql`exists (
        select 1 from ${meetingAgendas} attachment_agenda
        inner join ${recordingFolderAssignments} agenda_filing
            on agenda_filing.recording_id = attachment_agenda.meeting_item_id
           and agenda_filing.user_id = attachment_agenda.user_id
        where attachment_agenda.recording_item_id = ${itemId}
          and attachment_agenda.user_id = ${folderOwner}
          and agenda_filing.folder_id = ${folderId}
    )`,
    );
}

/** The author retains access to a colleague's recording explicitly filed in the author's own folder. */
export function authorAgendaRecordingIds(userId: string) {
    return sql`select ${meetingAgendas.recordingItemId} from ${meetingAgendas}
        inner join recording_folder_assignments agenda_filing on agenda_filing.recording_id = ${meetingAgendas.meetingItemId}
            and agenda_filing.user_id = ${userId}
        inner join recording_folders agenda_folder on agenda_folder.id = agenda_filing.folder_id and agenda_folder.user_id = ${userId}
        inner join recording_folder_assignments recording_filing on recording_filing.recording_id = ${meetingAgendas.recordingItemId}
            and recording_filing.folder_id = agenda_folder.id
        where ${meetingAgendas.userId} = ${userId} and ${meetingAgendas.recordingItemId} is not null`;
}
