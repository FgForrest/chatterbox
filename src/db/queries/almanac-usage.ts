import { sql } from "drizzle-orm";
import { db } from "@/db";

/** How often one person or entity came up in an owner's transcripts. */
export interface AlmanacUsageRow {
    personId: string | null;
    entityId: string | null;
    /** Transcripts naming it since `recentSince`. */
    recent: number;
    /** Transcripts naming it at all. */
    total: number;
    lastAt: Date;
}

/**
 * The people and entities `ownerUserId`'s transcripts name: speakers not
 * rejected, accepted corrections, and the facts their evidence supports,
 * counted once per transcript.
 */
export async function almanacUsage(
    ownerUserId: string,
    recentSince: Date,
): Promise<AlmanacUsageRow[]> {
    const since = recentSince.toISOString();
    const rows = await db.execute<{
        person_id: string | null;
        entity_id: string | null;
        recent: number;
        total: number;
        last_at: string | Date;
    }>(sql`
        with uses as (
            select ts.person_id, null::text as entity_id,
                   ts.transcription_id, ts.updated_at as at
            from transcript_speakers ts
            join transcriptions t on t.id = ts.transcription_id
            where t.user_id = ${ownerUserId}
              and ts.person_id is not null
              and ts.status <> 'rejected'
              and ts.marked_unknown = false
            union all
            select tc.target_person_id, tc.target_entity_id,
                   tc.transcription_id, tc.created_at
            from transcript_corrections tc
            join transcriptions t on t.id = tc.transcription_id
            where t.user_id = ${ownerUserId}
            union all
            select f.subject_person_id, f.subject_entity_id,
                   e.transcription_id, e.confirmed_at
            from knowledge_fact_evidence e
            join knowledge_facts f on f.id = e.fact_id
            join transcriptions t on t.id = e.transcription_id
            where t.user_id = ${ownerUserId}
            union all
            select f.object_person_id, f.object_entity_id,
                   e.transcription_id, e.confirmed_at
            from knowledge_fact_evidence e
            join knowledge_facts f on f.id = e.fact_id
            join transcriptions t on t.id = e.transcription_id
            where t.user_id = ${ownerUserId}
              and (f.object_person_id is not null
                   or f.object_entity_id is not null)
        )
        select person_id, entity_id,
               count(distinct transcription_id)
                   filter (where at >= ${since}::timestamp)::int as recent,
               count(distinct transcription_id)::int as total,
               max(at) as last_at
        from uses
        group by person_id, entity_id
    `);
    return rows.map((row) => ({
        personId: row.person_id,
        entityId: row.entity_id,
        recent: Number(row.recent),
        total: Number(row.total),
        lastAt: new Date(row.last_at),
    }));
}

/**
 * People and entities named by other items placed in `scopeFolderIds`.
 * Private view sees the owner's items; Organization view sees items placed
 * in the Organization tree.
 */
export async function almanacScopeUsage(input: {
    ownerUserId: string;
    orgUserId: string | null;
    itemId?: string;
    view: "private" | "org";
    scopeFolderIds: readonly string[];
    recentSince: Date;
}): Promise<AlmanacUsageRow[]> {
    if (input.scopeFolderIds.length === 0) return [];
    const since = input.recentSince.toISOString();
    const folderIds = [...input.scopeFolderIds];
    const rows = await db.execute<{
        person_id: string | null;
        entity_id: string | null;
        recent: number;
        total: number;
        last_at: string | Date;
    }>(sql`
        with visible_items as (
            select distinct item.id, item.user_id
            from recording_folder_assignments assignment
            join recording_folders folder on folder.id = assignment.folder_id
            join chatter_items item
              on item.id = assignment.recording_id
             and item.user_id = assignment.user_id
            where assignment.folder_id = any(${sql.param(folderIds)}::text[])
              and (${input.itemId ?? null}::text is null or item.id <> ${input.itemId ?? null})
              and item.deleted_at is null
              and (${input.itemId ?? null}::text is null or exists (
                  select 1
                  from chatter_items scoped_item
                  where scoped_item.id = ${input.itemId ?? null}
                    and scoped_item.user_id = ${input.ownerUserId}
                    and scoped_item.deleted_at is null
              ))
              and (
                  (${input.view} = 'private'
                   and item.user_id = ${input.ownerUserId}
                   and assignment.user_id = ${input.ownerUserId}
                   and (
                       folder.user_id = ${input.ownerUserId}
                       or folder.user_id = ${input.orgUserId}
                   ))
                  or
                  (${input.view} = 'org'
                   and folder.user_id = ${input.orgUserId})
              )
        ), uses as (
            select speaker.person_id, null::text as entity_id,
                   transcript.recording_id as item_id, speaker.updated_at as at
            from transcript_speakers speaker
            join transcriptions transcript on transcript.id = speaker.transcription_id
            join visible_items visible
              on visible.id = transcript.recording_id
             and visible.user_id = transcript.user_id
            where speaker.person_id is not null
              and speaker.status <> 'rejected'
              and speaker.marked_unknown = false
            union all
            select correction.target_person_id, correction.target_entity_id,
                   transcript.recording_id, correction.created_at
            from transcript_corrections correction
            join transcriptions transcript on transcript.id = correction.transcription_id
            join visible_items visible
              on visible.id = transcript.recording_id
             and visible.user_id = transcript.user_id
            union all
            select fact.subject_person_id, fact.subject_entity_id,
                   transcript.recording_id, evidence.confirmed_at
            from knowledge_fact_evidence evidence
            join knowledge_facts fact on fact.id = evidence.fact_id
            join transcriptions transcript on transcript.id = evidence.transcription_id
            join visible_items visible
              on visible.id = transcript.recording_id
             and visible.user_id = transcript.user_id
            union all
            select fact.object_person_id, fact.object_entity_id,
                   transcript.recording_id, evidence.confirmed_at
            from knowledge_fact_evidence evidence
            join knowledge_facts fact on fact.id = evidence.fact_id
            join transcriptions transcript on transcript.id = evidence.transcription_id
            join visible_items visible
              on visible.id = transcript.recording_id
             and visible.user_id = transcript.user_id
            where fact.object_person_id is not null
               or fact.object_entity_id is not null
        )
        select person_id, entity_id,
               count(distinct item_id)
                   filter (where at >= ${since}::timestamp)::int as recent,
               count(distinct item_id)::int as total,
               max(at) as last_at
        from uses
        group by person_id, entity_id
    `);
    return rows.map((row) => ({
        personId: row.person_id,
        entityId: row.entity_id,
        recent: Number(row.recent),
        total: Number(row.total),
        lastAt: new Date(row.last_at),
    }));
}
