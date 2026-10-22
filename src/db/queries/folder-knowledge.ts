import { type SQL, sql } from "drizzle-orm";
import { db } from "@/db";

export interface FolderKnowledgeScope {
    folderId: string;
    ownerId: string;
    viewerId: string;
    shared: boolean;
    allOwnedItems: boolean;
    scopes: string[];
}

function folderItems(input: FolderKnowledgeScope) {
    const items = input.allOwnedItems
        ? sql`
            select item.id, item.user_id, item.title, item.occurred_at
            from chatter_items item
            where item.deleted_at is null and item.user_id = ${input.viewerId}
        `
        : sql`
            select distinct item.id, item.user_id, item.title, item.occurred_at
            from folders folder
            join recording_folder_assignments assignment on assignment.folder_id = folder.id
            join chatter_items item on item.id = assignment.recording_id and item.user_id = assignment.user_id
            where item.deleted_at is null
              and (${input.shared} or assignment.user_id = ${input.viewerId})
        `;
    return sql`
        with recursive folders as (
            select id, parent_id, kind from recording_folders
            where id = ${input.folderId} and user_id = ${input.ownerId}
            union
            select child.id, child.parent_id, child.kind
            from recording_folders child join folders parent on child.parent_id = parent.id
            where child.user_id = ${input.ownerId}
        ), visible_items as (${items})
    `;
}

async function folderResult<Row extends Record<string, unknown>>(
    input: FolderKnowledgeScope,
    results: SQL,
    ctes: SQL = sql``,
    pagination?: { offset: number; limit: number },
) {
    const page = pagination
        ? sql`${results} limit ${pagination.limit} offset ${pagination.offset}`
        : results;
    const [row] = await db.execute<{
        item_count: number;
        subfolder_count: number;
        ranking_folder_ids: string[];
        rows: Row[];
    }>(sql`${folderItems(input)} ${ctes}
        select (select count(*)::int from visible_items) as item_count,
               (select count(*)::int from folders where id <> ${input.folderId}) as subfolder_count,
               array(select id from folders where parent_id is not null order by id) as ranking_folder_ids,
               (select coalesce(json_agg(page), '[]'::json) from (${page}) page) as rows
    `);
    const rows = row?.rows ?? [];
    let total = Number(rows[0]?.total ?? 0);
    if (rows.length === 0 && pagination && pagination.offset > 0) {
        const [count] = await db.execute<{ total: number }>(sql`
            ${folderItems(input)} ${ctes}
            select count(*)::int as total from (${results}) results
        `);
        total = Number(count?.total ?? 0);
    }
    return {
        context: {
            itemCount: Number(row?.item_count ?? 0),
            subfolderCount: Number(row?.subfolder_count ?? 0),
            rankingFolderIds: row?.ranking_folder_ids ?? [],
        },
        rows,
        total,
    };
}

/** Item counts and the folder IDs that a newly filed item's ranking will use. */
export async function folderKnowledgeContext(input: FolderKnowledgeScope) {
    return (await folderResult(input, sql`select null where false`)).context;
}

function folderUses(input: FolderKnowledgeScope) {
    return sql`, uses as (
        select speaker.person_id, null::text as entity_id, item.id as item_id, speaker.updated_at as at
        from transcript_speakers speaker
        join transcriptions transcript on transcript.id = speaker.transcription_id
        join visible_items item on item.id = transcript.recording_id and item.user_id = transcript.user_id
        where speaker.status = 'confirmed' and not speaker.marked_unknown
          and speaker.user_id = item.user_id
        union all
        select correction.target_person_id, correction.target_entity_id, item.id, correction.created_at
        from transcript_corrections correction
        join transcriptions transcript on transcript.id = correction.transcription_id
        join visible_items item on item.id = transcript.recording_id and item.user_id = transcript.user_id
        where correction.user_id = any(${sql.param(input.scopes)}::text[])
        union all
        select fact.subject_person_id, fact.subject_entity_id, item.id, evidence.confirmed_at
        from knowledge_fact_evidence evidence
        join knowledge_facts fact on fact.id = evidence.fact_id and fact.user_id = evidence.user_id
        join visible_items item on item.id = evidence.recording_id
        where fact.user_id = any(${sql.param(input.scopes)}::text[])
          and evidence.status = 'supported' and fact.replaced_by_fact_id is null
        union all
        select fact.object_person_id, fact.object_entity_id, item.id, evidence.confirmed_at
        from knowledge_fact_evidence evidence
        join knowledge_facts fact on fact.id = evidence.fact_id and fact.user_id = evidence.user_id
        join visible_items item on item.id = evidence.recording_id
        where fact.user_id = any(${sql.param(input.scopes)}::text[])
          and evidence.status = 'supported' and fact.replaced_by_fact_id is null
    )`;
}

export type FolderRecordRow = {
    id: string;
    name: string;
    type_key: string;
    user_id: string;
    has_email: boolean;
    item_count: number;
    last_at: string | Date;
    total: number;
};

/** Bounded people or entities mentioned in visible items, counted once per item. */
export async function folderKnowledgeRecords(
    input: FolderKnowledgeScope,
    kind: "people" | "things",
    offset: number,
    limit: number,
) {
    const records =
        kind === "people"
            ? sql`
        select person.id, person.display_name as name, 'person'::text as type_key, person.user_id,
               (person.primary_email is not null or exists (
                   select 1 from person_emails email where email.person_id = person.id
                     and email.user_id = any(${sql.param(input.scopes)}::text[])
               )) as has_email, uses.item_id, uses.at
        from people person join uses on uses.person_id = person.id
        where person.user_id = any(${sql.param(input.scopes)}::text[]) and person.merged_into_id is null
    `
            : sql`
        select entity.id, entity.name, entity.type_key, entity.user_id,
               false as has_email, uses.item_id, uses.at
        from knowledge_entities entity join uses on uses.entity_id = entity.id
        where entity.user_id = any(${sql.param(input.scopes)}::text[]) and entity.merged_into_id is null
    `;
    return folderResult<FolderRecordRow>(
        input,
        sql`
        select id, name, type_key, user_id, has_email, count(distinct item_id)::int as item_count,
               max(at) as last_at, count(*) over()::int as total
        from records group by id, name, type_key, user_id, has_email
        order by item_count desc, last_at desc, id
    `,
        sql`${folderUses(input)}, records as (${records})`,
        { offset, limit },
    );
}

export type FolderCorrectionRow = {
    id: string;
    heard: string;
    target_id: string;
    target_name: string;
    user_id: string;
    use_count: number;
    item_count: number;
    last_at: string | Date;
    total: number;
};

/** Heard-as corrections used in this folder, grouped by hashed form and target. */
export async function folderKnowledgeCorrections(
    input: FolderKnowledgeScope,
    offset: number,
    limit: number,
) {
    return folderResult<FolderCorrectionRow>(
        input,
        sql`
        select min(id) as id, (array_agg(heard order by id))[1] as heard, target_id, target_name, user_id,
               count(*)::int as use_count, count(distinct item_id)::int as item_count,
               max(created_at) as last_at, count(*) over()::int as total
        from corrections where target_id is not null
        group by heard_hmac, target_id, target_name, user_id
        order by use_count desc, last_at desc, id
    `,
        sql`, corrections as (
        select correction.*, item.id as item_id,
               coalesce(person.id, entity.id) as target_id,
               coalesce(person.display_name, entity.name) as target_name
        from transcript_corrections correction
        join transcriptions transcript on transcript.id = correction.transcription_id
        join visible_items item on item.id = transcript.recording_id and item.user_id = transcript.user_id
        left join people person on person.id = correction.target_person_id
          and person.user_id = any(${sql.param(input.scopes)}::text[]) and person.merged_into_id is null
        left join knowledge_entities entity on entity.id = correction.target_entity_id
          and entity.user_id = any(${sql.param(input.scopes)}::text[]) and entity.merged_into_id is null
        where correction.user_id = any(${sql.param(input.scopes)}::text[]) and correction.kind = 'correct'
    )`,
        { offset, limit },
    );
}

export type FolderFactRow = {
    id: string;
    fact_id: string;
    subject_name: string;
    relation_key: string;
    object_name: string;
    item_id: string;
    item_title: string;
    item_date: string | Date;
    user_id: string;
    total: number;
};

/** Current supported facts with their evidence item, including mail evidence. */
export async function folderKnowledgeFacts(
    input: FolderKnowledgeScope,
    offset: number,
    limit: number,
) {
    return folderResult<FolderFactRow>(
        input,
        sql`
        select evidence.id, fact.id as fact_id,
               coalesce(subject_person.display_name, subject_entity.name) as subject_name,
               fact.relation_key, coalesce(object_person.display_name, object_entity.name, fact.object_literal) as object_name,
               item.id as item_id, item.title as item_title, item.occurred_at as item_date,
               fact.user_id, count(*) over()::int as total
        from knowledge_fact_evidence evidence
        join knowledge_facts fact on fact.id = evidence.fact_id and fact.user_id = evidence.user_id
        join visible_items item on item.id = evidence.recording_id
        left join people subject_person on subject_person.id = fact.subject_person_id
          and subject_person.user_id = any(${sql.param(input.scopes)}::text[])
        left join knowledge_entities subject_entity on subject_entity.id = fact.subject_entity_id
          and subject_entity.user_id = any(${sql.param(input.scopes)}::text[])
        left join people object_person on object_person.id = fact.object_person_id
          and object_person.user_id = any(${sql.param(input.scopes)}::text[])
        left join knowledge_entities object_entity on object_entity.id = fact.object_entity_id
          and object_entity.user_id = any(${sql.param(input.scopes)}::text[])
        where fact.user_id = any(${sql.param(input.scopes)}::text[])
          and evidence.status = 'supported' and fact.replaced_by_fact_id is null
          and coalesce(subject_person.id, subject_entity.id) is not null
          and (fact.object_literal is not null or coalesce(object_person.id, object_entity.id) is not null)
        order by item.occurred_at desc, evidence.id
    `,
        sql``,
        { offset, limit },
    );
}
