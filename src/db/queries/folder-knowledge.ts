import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { confirmedLearnRecordsInTx } from "@/db/queries/learn-confirmed-records";
import { learnReviewItems, learnRuns } from "@/db/schema";
import type { RecordTarget } from "@/lib/learn/new-refs";

export interface FolderKnowledgeScope {
    folderId: string;
    itemId?: string;
    ownerId: string;
    viewerId: string;
    shared: boolean;
    allOwnedItems: boolean;
    scopes: string[];
    legacyRecordsByRun?: Record<string, RecordTarget[]>;
}

function folderItems(input: FolderKnowledgeScope) {
    if (input.itemId)
        return sql`
        with folders as (
            select folder.id, folder.parent_id, folder.kind from recording_folders folder
            join recording_folder_assignments assignment on assignment.folder_id = folder.id
            where assignment.recording_id = ${input.itemId}
              and assignment.user_id = ${input.ownerId}
              and folder.user_id = any(${sql.param(input.scopes)}::text[])
        ), visible_items as (
            select item.id, item.user_id, item.title, item.occurred_at from chatter_items item
            where item.id = ${input.itemId} and item.user_id = ${input.ownerId}
              and item.deleted_at is null and item.kind in ('audio', 'mail')
        )
    `;
    const items = input.allOwnedItems
        ? sql`
            select item.id, item.user_id, item.title, item.occurred_at
            from chatter_items item
            where item.deleted_at is null and item.kind in ('audio', 'mail') and item.user_id = ${input.viewerId}
        `
        : sql`
            select distinct item.id, item.user_id, item.title, item.occurred_at
            from folders folder
            join recording_folder_assignments assignment on assignment.folder_id = folder.id
            join chatter_items item on item.id = assignment.recording_id and item.user_id = assignment.user_id
            where item.deleted_at is null and item.kind in ('audio', 'mail')
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

function additionRuns(input: FolderKnowledgeScope) {
    return sql`, addition_runs as (
        select run.id as run_id, run.inputs, item.id as item_id, item.user_id as owner_id, coalesce(run.finished_at, run.created_at) as at
        from learn_runs run
        join visible_items item on item.id = run.recording_id and item.user_id = run.user_id
        where run.scope_user_id = any(${sql.param(input.scopes)}::text[]) and run.status = 'finished'
        union all
        select origin.id, origin.inputs, item.id, item.user_id, coalesce(receipt.finished_at, receipt.created_at)
        from learn_runs receipt
        join visible_items item on item.id = receipt.recording_id and item.user_id = receipt.user_id
        join learn_runs origin on origin.id = receipt.inputs->>'promotedFromRunId'
          and origin.recording_id = item.id and origin.user_id = item.user_id
          and origin.scope_user_id = item.user_id and origin.view = 'private' and origin.status = 'finished'
        where receipt.scope_user_id = any(${sql.param(input.scopes)}::text[])
          and receipt.view = 'org' and receipt.status = 'finished'
    )`;
}

/** Reconstruct legacy additions once per authorized item read, without returning review payloads. */
export async function itemKnowledgeLegacyRecords(input: FolderKnowledgeScope) {
    const recordsByRun: Record<string, RecordTarget[]> = {};
    const itemId = input.itemId;
    if (!itemId || input.scopes.length === 0) return recordsByRun;
    const legacy = await db.execute<{ run_id: string }>(sql`
        ${folderItems(input)} ${additionRuns(input)}
        select distinct run_id from addition_runs
        where jsonb_typeof(inputs->'confirmedRecords') is distinct from 'array'
          and exists (
              select 1 from learn_review_items review
              where review.run_id = addition_runs.run_id and review.user_id = addition_runs.owner_id
                and review.kind = 'new_record' and review.outcome = 'applied'
          )
    `);
    if (legacy.length === 0) return recordsByRun;
    return db.transaction(async (tx) => {
        const runIds = legacy.map((run) => run.run_id);
        const runs = await tx
            .select()
            .from(learnRuns)
            .where(
                and(
                    inArray(learnRuns.id, runIds),
                    eq(learnRuns.userId, input.ownerId),
                    eq(learnRuns.itemId, itemId),
                    eq(learnRuns.status, "finished"),
                ),
            );
        const rows = await tx
            .select()
            .from(learnReviewItems)
            .where(
                and(
                    inArray(learnReviewItems.runId, runIds),
                    eq(learnReviewItems.userId, input.ownerId),
                    eq(learnReviewItems.kind, "new_record"),
                    eq(learnReviewItems.outcome, "applied"),
                ),
            );
        const scopes = [...new Set([input.ownerId, ...input.scopes])];
        for (const run of runs) {
            recordsByRun[run.id] = await confirmedLearnRecordsInTx(
                tx,
                run,
                rows.filter((row) => row.runId === run.id),
                scopes,
            );
        }
        return recordsByRun;
    });
}

function itemAdditions(input: FolderKnowledgeScope) {
    return sql`${additionRuns(input)}, item_additions as (
        select person.id as person_id, entity.id as entity_id, run.item_id, run.at
        from addition_runs run
        cross join lateral jsonb_array_elements(
            case when jsonb_typeof(run.inputs->'confirmedRecords') = 'array'
            then run.inputs->'confirmedRecords'
            else coalesce(${JSON.stringify(input.legacyRecordsByRun ?? {})}::jsonb->run.run_id, '[]'::jsonb) end
        ) record(target)
        left join people original_person on original_person.id = record.target->>'personId'
          and (original_person.user_id = run.owner_id or original_person.user_id = any(${sql.param(input.scopes)}::text[]))
        left join people person on person.id = coalesce(original_person.merged_into_id, original_person.id)
          and person.user_id = any(${sql.param(input.scopes)}::text[]) and person.merged_into_id is null
        left join knowledge_entities original_entity on original_entity.id = record.target->>'entityId'
          and (original_entity.user_id = run.owner_id or original_entity.user_id = any(${sql.param(input.scopes)}::text[]))
        left join knowledge_entities entity on entity.id = coalesce(original_entity.merged_into_id, original_entity.id)
          and entity.user_id = any(${sql.param(input.scopes)}::text[]) and entity.merged_into_id is null
        where person.id is not null or entity.id is not null
    )`;
}

/** Currently readable additions from finished item runs and their publication receipts. */
export async function itemKnowledgeNewRecordIds(input: FolderKnowledgeScope) {
    const rows = await db.execute<{ id: string }>(sql`
        ${folderItems(input)} ${itemAdditions(input)}
        select distinct coalesce(person_id, entity_id) as id from item_additions order by id
    `);
    return rows.map((row) => row.id);
}

function folderUses(input: FolderKnowledgeScope) {
    const additions = input.itemId
        ? sql`
        union all
        select person_id, entity_id, item_id, at from item_additions
    `
        : sql``;
    return sql`${input.itemId ? itemAdditions(input) : sql``}, uses as (
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
        ${additions}
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
    new_from_item: boolean;
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
               not exists (
                   select 1 from knowledge_fact_evidence earlier
                   where earlier.fact_id = fact.id and earlier.user_id = fact.user_id
                     and earlier.status = 'supported' and earlier.recording_id <> item.id
                     and (earlier.confirmed_at, earlier.id) < (evidence.confirmed_at, evidence.id)
               ) as new_from_item,
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
