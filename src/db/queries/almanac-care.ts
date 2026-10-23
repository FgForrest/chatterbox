import { sql } from "drizzle-orm";
import { db } from "@/db";

type Executor = Pick<typeof db, "execute">;
export const CARE_RECORD_LIMIT = 2000;
export const CARE_PROBLEM_LIMIT = 2000;

/** Bounded conflicting current values on live Organization subjects, using relation cardinality. */
export async function conflictingCareFacts(
    scope: string,
    executor: Executor = db,
) {
    return executor.execute<{
        subject_key: string;
        relation_key: string;
        ids: string[];
    }>(sql`
        with records as (
            (select 'p:' || id as key from people where user_id = ${scope} and merged_into_id is null order by created_at desc, id limit ${CARE_RECORD_LIMIT})
            union all
            (select 'e:' || id from knowledge_entities where user_id = ${scope} and merged_into_id is null order by created_at desc, id limit ${CARE_RECORD_LIMIT})
        ), current_facts as (
            select f.* from knowledge_facts f join records r on r.key = f.subject_key
            where f.user_id = ${scope} and f.replaced_by_fact_id is null
            order by f.updated_at desc, f.id limit ${CARE_RECORD_LIMIT * 16}
        )
        select f.subject_key, f.relation_key, array_agg(f.id order by f.id) as ids
        from current_facts f
        join knowledge_relation_types relation on relation.key = f.relation_key
          and (relation.user_id is null or relation.user_id = ${scope})
          and relation.cardinality = 'one' and relation.status = 'active'
        where f.user_id = ${scope} and f.replaced_by_fact_id is null
        group by f.subject_key, f.relation_key
        having count(distinct f.object_key) > 1
        order by f.subject_key, f.relation_key limit ${CARE_PROBLEM_LIMIT}
    `);
}

/** Heard-as forms with distinct live Organization targets; ordinary nicknames are not corrections. */
export async function conflictingCareCorrections(
    scope: string,
    executor: Executor = db,
) {
    return executor.execute<{ heard_hmac: string; ids: string[] }>(sql`
        with forms as (
            select a.* from knowledge_aliases a
            left join people p on p.id = a.person_id and p.user_id = ${scope} and p.merged_into_id is null
            left join knowledge_entities e on e.id = a.entity_id and e.user_id = ${scope} and e.merged_into_id is null
            where a.user_id = ${scope} and a.kind = 'heard_as' and (p.id is not null or e.id is not null)
            order by a.updated_at desc, a.id limit ${CARE_RECORD_LIMIT * 8}
        )
        select text_hmac as heard_hmac, array_agg(id order by id) as ids from forms
        group by text_hmac having count(distinct coalesce('p:' || person_id, 'e:' || entity_id)) > 1
        order by text_hmac limit ${CARE_PROBLEM_LIMIT}
    `);
}

/** One Organization-visible item mention, no facts in either direction, and no use for 120 days. */
export async function thinCareRecords(
    scope: string,
    since: Date,
    executor: Executor = db,
) {
    const cutoff = since.toISOString();
    return executor.execute<{
        kind: "person" | "entity";
        id: string;
        last_at: string | Date;
    }>(sql`
        with records as (
            (select 'person' as kind, id, updated_at from people where user_id = ${scope} and merged_into_id is null order by created_at desc, id limit ${CARE_RECORD_LIMIT})
            union all
            (select 'entity', id, updated_at from knowledge_entities where user_id = ${scope} and merged_into_id is null order by created_at desc, id limit ${CARE_RECORD_LIMIT})
        ), visible_items as (
            select distinct item.id from chatter_items item
            join recording_folder_assignments a on a.recording_id = item.id and a.user_id = item.user_id
            join recording_folders folder on folder.id = a.folder_id and folder.user_id = ${scope}
            where item.deleted_at is null
        ), uses as (
            select 'person' as kind, speaker.person_id as id, t.recording_id as item_id, speaker.updated_at as at
            from transcript_speakers speaker join transcriptions t on t.id = speaker.transcription_id
            join visible_items v on v.id = t.recording_id
            where speaker.person_id is not null and speaker.status <> 'rejected' and not speaker.marked_unknown
              and exists (select 1 from records r where r.kind = 'person' and r.id = speaker.person_id)
            union all
            select case when c.target_person_id is not null then 'person' else 'entity' end,
                coalesce(c.target_person_id, c.target_entity_id), t.recording_id, c.updated_at
            from transcript_corrections c join transcriptions t on t.id = c.transcription_id
            join visible_items v on v.id = t.recording_id where c.user_id = ${scope}
              and exists (select 1 from records r where (r.kind = 'person' and r.id = c.target_person_id) or (r.kind = 'entity' and r.id = c.target_entity_id))
            union all
            select 'person', participant.person_id, participant.item_id, participant.created_at
            from mail_participants participant join visible_items v on v.id = participant.item_id
            where participant.person_id is not null
              and exists (select 1 from records r where r.kind = 'person' and r.id = participant.person_id)
        )
        select r.kind, r.id, max(u.at) as last_at from records r join uses u on u.id = r.id and u.kind = r.kind
        where r.updated_at < ${cutoff}::timestamp and not exists (
            select 1 from knowledge_facts f where f.user_id = ${scope}
            and ((r.kind = 'person' and (f.subject_person_id = r.id or f.object_person_id = r.id))
              or (r.kind = 'entity' and (f.subject_entity_id = r.id or f.object_entity_id = r.id)))
        )
        group by r.kind, r.id having count(distinct u.item_id) = 1 and max(u.at) < ${cutoff}::timestamp
        order by r.kind, r.id limit ${CARE_PROBLEM_LIMIT}
    `);
}
