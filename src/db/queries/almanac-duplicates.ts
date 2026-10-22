import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { DuplicateKind } from "@/lib/knowledge/duplicate-score";

/** Organization aliases and addresses, bounded per record before decryption. */
export async function duplicateForms(
    scope: string,
    kind: DuplicateKind,
    ids: string[],
) {
    const target = kind === "person" ? sql`person_id` : sql`entity_id`;
    const aliases = await db.execute<{
        id: string;
        kind: "alias" | "heard_as";
        text: string;
    }>(sql`
        select id, kind, text from (
            select ${target} as id, kind, text,
                row_number() over (partition by ${target}, kind order by created_at, knowledge_aliases.id) as n
            from knowledge_aliases where user_id = ${scope}
                and ${target} = any(${sql.param(ids)}::text[])
        ) forms where n <= 8
    `);
    const emails =
        kind === "person"
            ? await db.execute<{ id: string; email: string }>(sql`
        select id, email from (
            select person_id as id, email,
                row_number() over (partition by person_id order by created_at, email_hash) as n
            from person_emails where user_id = ${scope} and person_id = any(${sql.param(ids)}::text[])
        ) addresses where n <= 16
    `)
            : [];
    return { aliases, emails };
}

/** Counts only Organization evidence and shared confirmed speaker appearances. */
export async function duplicateEvidence(
    scope: string,
    kind: DuplicateKind,
    ids: string[],
) {
    return db.execute<{ id: string; count: number }>(sql`
        with named as (
            select unnest(array[
                case when ${kind} = 'person' then subject_person_id else subject_entity_id end,
                case when ${kind} = 'person' then object_person_id else object_entity_id end
            ]) as id, f.id as fact_id from knowledge_facts f where f.user_id = ${scope}
        ), evidence as (
            select named.id from named join knowledge_fact_evidence e on e.fact_id = named.fact_id
            where named.id = any(${sql.param(ids)}::text[]) and e.user_id = ${scope} and e.status = 'supported'
            union all
            select s.person_id as id from transcript_speakers s
            join transcriptions t on t.id = s.transcription_id
            join chatter_items i on i.id = t.recording_id
            where ${kind} = 'person' and s.person_id = any(${sql.param(ids)}::text[]) and s.status = 'confirmed'
                and s.user_id in (${scope}, t.user_id) and i.deleted_at is null
                and exists (select 1 from recording_folder_assignments a join recording_folders f on f.id = a.folder_id
                    where a.recording_id = i.id and f.user_id = ${scope})
        ) select id, count(*)::integer as count from evidence group by id
    `);
}

/** Current dismissed pairs, using the scope and kind prefix of the unique index. */
export async function duplicateDismissals(scope: string, kind: DuplicateKind) {
    return kind === "person"
        ? db.execute<{ left: string; right: string }>(sql`
            select left_person_id as left, right_person_id as right
            from almanac_duplicate_dismissals where user_id = ${scope} and kind = ${kind}
        `)
        : db.execute<{ left: string; right: string }>(sql`
            select left_entity_id as left, right_entity_id as right
            from almanac_duplicate_dismissals where user_id = ${scope} and kind = ${kind}
        `);
}

/** Shared co-speaker evidence for precisely the bounded candidate pairs. */
export async function duplicatePairSignals(
    scope: string,
    kind: DuplicateKind,
    pairs: readonly { left: string; right: string }[],
) {
    if (!pairs.length) return { speakers: [] };
    if (pairs.length > 500) {
        const speakers: { left: string; right: string }[] = [];
        for (let offset = 0; offset < pairs.length; offset += 500) {
            const chunk = await duplicatePairSignals(
                scope,
                kind,
                pairs.slice(offset, offset + 500),
            );
            speakers.push(...chunk.speakers);
        }
        return { speakers };
    }
    const left = pairs.map((pair) => pair.left);
    const right = pairs.map((pair) => pair.right);
    const speakers =
        kind === "person"
            ? await db.execute<{ left: string; right: string }>(sql`
        select p.l as left, p.r as right from unnest(${sql.param(left)}::text[], ${sql.param(right)}::text[]) as p(l, r)
        where exists (
            select 1 from transcript_speakers a
            join transcript_speakers b on b.transcription_id = a.transcription_id and b.person_id = p.r
            join transcriptions t on t.id = a.transcription_id
            join chatter_items i on i.id = t.recording_id
            where a.person_id = p.l and a.status = 'confirmed' and b.status = 'confirmed'
                and a.user_id in (${scope}, t.user_id) and b.user_id in (${scope}, t.user_id)
                and i.deleted_at is null
                and exists (select 1 from recording_folder_assignments fa join recording_folders f on f.id = fa.folder_id
                    where fa.recording_id = i.id and f.user_id = ${scope})
        )
    `)
            : [];
    return { speakers };
}
