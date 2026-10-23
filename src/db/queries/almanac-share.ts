import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeEntities, people } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** PostgreSQL transaction identity, shared by every publisher in one share. */
export async function shareTransactionId(tx: Tx): Promise<string> {
    const [row] = await tx.execute<{ id: string }>(
        sql`select pg_current_xact_id()::text as id`,
    );
    if (!row) throw new Error("Share transaction unavailable");
    return row.id;
}

/** Refuse a record erasure if it would cascade into any source outside the removable additions. */
export async function shareRecordHasOtherSources(
    tx: Tx,
    input: {
        scope: string;
        kind: "person" | "entity";
        id: string;
        itemId: string | null;
        since: Date;
        facts: string[];
        corrections: string[];
        aliases: string[];
        emails: string[];
        allowOrganizationForms?: boolean;
    },
): Promise<boolean> {
    const at = input.since.toISOString();
    const [row] = await tx.execute<{ used: boolean }>(sql`
        with source_item as materialized (
            select item.id from chatter_items item
            where item.id = ${input.itemId} and item.deleted_at is null
                and exists (select 1 from recording_folder_assignments a
                    join recording_folders folder on folder.id = a.folder_id and folder.user_id = ${input.scope}
                    where a.recording_id = item.id and a.user_id = item.user_id)
        )
        select exists (
            select 1 from knowledge_facts f
            where (f.subject_person_id = ${input.id} or f.object_person_id = ${input.id}
                or f.subject_entity_id = ${input.id} or f.object_entity_id = ${input.id})
                and not (f.user_id = ${input.scope} and f.id = any(${sql.param(input.facts)}::text[]))
            union all
            select 1 from knowledge_aliases a where (a.person_id = ${input.id} or a.entity_id = ${input.id})
                and not (a.user_id = ${input.scope} and (${input.allowOrganizationForms ?? false} or a.id = any(${sql.param(input.aliases)}::text[])))
            union all
            select 1 from transcript_corrections c where (c.target_person_id = ${input.id} or c.target_entity_id = ${input.id})
                and not (c.user_id = ${input.scope} and (
                    (${input.allowOrganizationForms ?? false} and exists (
                        select 1 from transcriptions t where t.id = c.transcription_id and t.recording_id = (select id from source_item)
                    )) or c.id = any(${sql.param(input.corrections)}::text[])))
            union all
            select 1 from knowledge_aliases a join transcript_corrections c on c.id = a.correction_id
                where a.user_id <> ${input.scope} and (c.target_person_id = ${input.id} or c.target_entity_id = ${input.id})
            union all
            select 1 from person_notes n where n.person_id = ${input.id}
            union all
            select 1 from knowledge_entity_notes n where n.entity_id = ${input.id}
            union all
            select 1 from knowledge_vectors v where v.entity_id = ${input.id} and v.user_id <> ${input.scope}
            union all
            select 1 from almanac_duplicate_dismissals d where d.user_id <> ${input.scope}
                and (d.left_person_id = ${input.id} or d.right_person_id = ${input.id}
                  or d.left_entity_id = ${input.id} or d.right_entity_id = ${input.id})
            union all
            select 1 from person_emails e where e.person_id = ${input.id}
                and not (e.user_id = ${input.scope} and e.email_hash = any(${sql.param(input.emails)}::text[]))
            union all
            select 1 from transcript_speakers s join transcriptions t on t.id = s.transcription_id
                where s.person_id = ${input.id} and (t.recording_id is distinct from (select id from source_item) or s.updated_at > ${at}::timestamp)
            union all
            select 1 from transcript_speaker_rejections r where r.person_id = ${input.id}
            union all
            select 1 from recording_tasks t where t.assignee_person_id = ${input.id}
                and (t.recording_id is distinct from (select id from source_item) or t.updated_at > ${at}::timestamp)
            union all
            select 1 from task_update_proposals t where t.proposed_assignee_person_id = ${input.id}
                and (t.recording_id is distinct from (select id from source_item) or t.updated_at > ${at}::timestamp)
            union all
            select 1 from mail_participants p where p.person_id = ${input.id} and p.item_id is distinct from (select id from source_item)
        ) as used
    `);
    return row?.used ?? true;
}

/** Both sides of a merge protect the surviving and redirected records from share undo. */
export async function shareRecordWasMerged(
    tx: Tx,
    scope: string,
    kind: "person" | "entity",
    id: string,
): Promise<boolean> {
    const [row] = await tx.execute<{ merged: boolean }>(
        kind === "person"
            ? sql`
        select exists(select 1 from people where (id = ${id} and merged_into_id is not null) or merged_into_id = ${id})
          and exists(select 1 from people where id = ${id} and user_id = ${scope}) as merged
    `
            : sql`
        select exists(select 1 from knowledge_entities where (id = ${id} and merged_into_id is not null) or merged_into_id = ${id})
          and exists(select 1 from knowledge_entities where id = ${id} and user_id = ${scope}) as merged
    `,
    );
    return row?.merged ?? false;
}

/** One actionable recent share per displayed record/fact, so folder flags do not depend on group pagination. */
export async function folderShareProblemRefs(
    scope: string,
    recordIds: string[],
    factIds: string[],
) {
    if (!recordIds.length && !factIds.length) return [];
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    return db.execute<{
        id: string;
        kind: "record" | "fact";
        event_id: string;
    }>(sql`
        with targets as (
            select unnest(${sql.param(recordIds)}::text[]) as id, 'record' as kind
            union all select unnest(${sql.param(factIds)}::text[]), 'fact'
        )
        select distinct on (target.kind, target.id) target.id, target.kind, event.id as event_id
        from targets target
        join almanac_share_changes change on change.user_id = ${scope} and change.added and change.removed_at is null
          and ((target.kind = 'record' and (change.record_person_id = target.id or change.record_entity_id = target.id))
            or (target.kind = 'fact' and change.kind = 'fact' and change.target_id = target.id))
        join almanac_share_events event on event.id = change.event_id and event.user_id = ${scope}
          and event.created_at >= ${since}::timestamp and event.reviewed_at is null and event.undone_at is null
        order by target.kind, target.id, event.created_at desc, event.id
    `);
}

/** After the Organization and recording locks, hold parent rows before dependency checks to block new FK references until commit. */
export async function lockCareRecords(
    tx: Tx,
    scope: string,
    personIds: string[],
    entityIds: string[],
): Promise<void> {
    if (personIds.length)
        await tx
            .select({ id: people.id })
            .from(people)
            .where(and(eq(people.userId, scope), inArray(people.id, personIds)))
            .orderBy(people.id)
            .for("update");
    if (entityIds.length)
        await tx
            .select({ id: knowledgeEntities.id })
            .from(knowledgeEntities)
            .where(
                and(
                    eq(knowledgeEntities.userId, scope),
                    inArray(knowledgeEntities.id, entityIds),
                ),
            )
            .orderBy(knowledgeEntities.id)
            .for("update");
}
