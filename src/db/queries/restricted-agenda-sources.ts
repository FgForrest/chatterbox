import { type AnyColumn, sql } from "drizzle-orm";
import { chatterItems } from "@/db/schema";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";

/** A withheld source can prepare only an unpublished agenda in the same restricted folder. */
export function agendaInputItemCondition(
    agendaItemId: string,
    sourceItemId: AnyColumn = chatterItems.id,
) {
    return sql`(not exists (select 1 from recording_folder_assignments source_placement
        inner join recording_folders source_folder on source_folder.id = source_placement.folder_id
        where source_placement.recording_id = ${sourceItemId} and (source_placement.withheld or source_folder.restricted_at is not null))
        or ${recordingSharedCondition(sourceItemId)}
        or (not ${recordingSharedCondition(sql`${agendaItemId}`)} and exists (
            select 1 from recording_folder_assignments agenda_placement
            inner join recording_folder_assignments source_placement on source_placement.folder_id = agenda_placement.folder_id
            where agenda_placement.recording_id = ${agendaItemId} and source_placement.recording_id = ${sourceItemId}
              and agenda_placement.withheld and source_placement.withheld)))`;
}
