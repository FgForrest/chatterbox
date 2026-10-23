import { sql } from "drizzle-orm";
import { db } from "@/db";

type Executor = Pick<typeof db, "execute">;
export const CARE_RECORD_LIMIT = 2000;
export const CARE_PROBLEM_LIMIT = 2000;
export const CARE_USAGE_LIMIT = 64;

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
        ), current_facts as materialized (
            select f.id, f.subject_key, f.relation_key, f.object_key from knowledge_facts f
            where f.user_id = ${scope} and f.replaced_by_fact_id is null
            order by f.updated_at desc, f.id limit ${CARE_RECORD_LIMIT * 16}
        )
        select f.subject_key, f.relation_key, array_agg(f.id order by f.id) as ids
        from current_facts f
        join records r on r.key = f.subject_key
        join knowledge_relation_types relation on relation.key = f.relation_key
          and (relation.user_id is null or relation.user_id = ${scope})
          and relation.cardinality = 'one' and relation.status = 'active'
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
        with candidates as materialized (
            select id, text_hmac, person_id, entity_id from knowledge_aliases where user_id = ${scope} and kind = 'heard_as'
            order by updated_at desc, id limit ${CARE_RECORD_LIMIT * 8}
        ), forms as (
            select a.* from candidates a
            left join lateral (select id from people where id = a.person_id and user_id = ${scope} and merged_into_id is null offset 0) p on true
            left join lateral (select id from knowledge_entities where id = a.entity_id and user_id = ${scope} and merged_into_id is null offset 0) e on true
            where p.id is not null or e.id is not null
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
        item_id: string;
    }>(sql`
        with records as (
            (select 'person' as kind, id, updated_at from people where user_id = ${scope} and merged_into_id is null order by created_at desc, id limit ${CARE_RECORD_LIMIT})
            union all
            (select 'entity', id, updated_at from knowledge_entities where user_id = ${scope} and merged_into_id is null order by created_at desc, id limit ${CARE_RECORD_LIMIT})
        ), sampled as materialized (
            select r.*, u.item_id, u.at, u.eligible from records r
            cross join lateral (
                (select t.recording_id as item_id, speaker.updated_at as at, speaker.status <> 'rejected' and not speaker.marked_unknown as eligible
                 from (select transcription_id, updated_at, status, marked_unknown from transcript_speakers
                       where r.kind = 'person' and person_id = r.id
                       limit ${CARE_USAGE_LIMIT + 1}) speaker
                 join transcriptions t on t.id = speaker.transcription_id)
                union all
                (select t.recording_id, c.updated_at, true
                 from (select transcription_id, updated_at from transcript_corrections
                       where (r.kind = 'person' and target_person_id = r.id)
                          or (r.kind = 'entity' and target_entity_id = r.id)
                       limit ${CARE_USAGE_LIMIT + 1}) c
                 join transcriptions t on t.id = c.transcription_id)
                union all
                (select item_id, created_at, true from mail_participants
                 where r.kind = 'person' and person_id = r.id limit ${CARE_USAGE_LIMIT + 1})
            ) u
            where r.updated_at < ${cutoff}::timestamp
        ), complete as (
            select kind, id from sampled group by kind, id
            having count(*) <= ${CARE_USAGE_LIMIT} and count(distinct item_id) = 1
        ), uses as (
            select s.* from sampled s join complete c on c.kind = s.kind and c.id = s.id
            where s.eligible and exists (
                select 1 from chatter_items item where item.id = s.item_id and item.deleted_at is null
                and exists (select 1 from recording_folder_assignments a
                    join recording_folders folder on folder.id = a.folder_id and folder.user_id = ${scope}
                    where a.recording_id = item.id and a.user_id = item.user_id)
            )
        )
        select r.kind, r.id, max(u.at) as last_at, min(u.item_id) as item_id
        from records r join uses u on u.id = r.id and u.kind = r.kind
        where not exists (
            select 1 from knowledge_facts f
            where ((r.kind = 'person' and (f.subject_person_id = r.id or f.object_person_id = r.id))
              or (r.kind = 'entity' and (f.subject_entity_id = r.id or f.object_entity_id = r.id)))
        )
        and not exists (select 1 from person_notes n where r.kind = 'person' and n.person_id = r.id)
        and not exists (select 1 from knowledge_entity_notes n where r.kind = 'entity' and n.entity_id = r.id)
        and not exists (select 1 from knowledge_aliases a where r.kind = 'person' and a.person_id = r.id and a.user_id < ${scope})
        and not exists (select 1 from knowledge_aliases a where r.kind = 'person' and a.person_id = r.id and a.user_id > ${scope})
        and not exists (select 1 from knowledge_aliases a where r.kind = 'entity' and a.entity_id = r.id and a.user_id < ${scope})
        and not exists (select 1 from knowledge_aliases a where r.kind = 'entity' and a.entity_id = r.id and a.user_id > ${scope})
        and not exists (select 1 from transcript_corrections c where c.user_id <> ${scope}
            and ((r.kind = 'person' and c.target_person_id = r.id) or (r.kind = 'entity' and c.target_entity_id = r.id)))
        and not exists (
            select 1 from (
                select id from transcript_corrections
                where (r.kind = 'person' and target_person_id = r.id) or (r.kind = 'entity' and target_entity_id = r.id)
                limit ${CARE_USAGE_LIMIT + 1}
            ) c where exists (select 1 from knowledge_aliases a where a.correction_id = c.id and a.user_id < ${scope})
                or exists (select 1 from knowledge_aliases a where a.correction_id = c.id and a.user_id > ${scope})
        )
        and not exists (select 1 from person_emails e where r.kind = 'person' and e.person_id = r.id)
        and not exists (select 1 from transcript_speaker_rejections s where r.kind = 'person' and s.person_id = r.id)
        and not exists (select 1 from recording_tasks t where r.kind = 'person' and t.assignee_person_id = r.id)
        and not exists (select 1 from task_update_proposals t where r.kind = 'person' and t.proposed_assignee_person_id = r.id)
        and not exists (select 1 from knowledge_vectors v where r.kind = 'entity' and v.entity_id = r.id and v.user_id <> ${scope})
        and not exists (select 1 from almanac_duplicate_dismissals d where d.user_id <> ${scope}
            and (d.left_person_id = r.id or d.right_person_id = r.id or d.left_entity_id = r.id or d.right_entity_id = r.id))
        and not exists (select 1 from people p where r.kind = 'person' and p.merged_into_id = r.id)
        and not exists (select 1 from knowledge_entities e where r.kind = 'entity' and e.merged_into_id = r.id)
        group by r.kind, r.id having count(distinct u.item_id) = 1 and max(u.at) < ${cutoff}::timestamp
        order by r.kind, r.id limit ${CARE_PROBLEM_LIMIT}
    `);
}
