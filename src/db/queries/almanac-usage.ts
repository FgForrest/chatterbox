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
