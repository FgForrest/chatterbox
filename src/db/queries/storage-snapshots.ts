import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    storageDailySnapshots,
    users,
} from "@/db/schema";

const SNAPSHOT_LOCK = "housekeeping.storage-snapshot";

/**
 * Measure instance-wide storage once per UTC day, on that day's first hourly
 * housekeeping run. An advisory transaction lock guards the day check and the
 * measurement. Any existing row for that day skips the run; accounts created
 * later wait until the next day. A failed run writes nothing, so the next
 * hourly run retries.
 */
export async function writeStorageSnapshots(now = new Date()): Promise<number> {
    return db.transaction(async (tx) => {
        const [claim] = await tx.execute<{ claimed: boolean }>(sql`
            select pg_try_advisory_xact_lock(hashtext(${"riffado:housekeeping"}), hashtext(${SNAPSHOT_LOCK})) as claimed
        `);
        if (!claim?.claimed) return 0;
        const [existing] = await tx
            .select({ day: storageDailySnapshots.day })
            .from(storageDailySnapshots)
            .where(
                eq(storageDailySnapshots.day, now.toISOString().slice(0, 10)),
            )
            .limit(1);
        if (existing) return 0;
        return measureStorageSnapshots(tx, now);
    });
}

async function measureStorageSnapshots(
    executor: Pick<typeof db, "execute">,
    now: Date,
): Promise<number> {
    const at = now.toISOString();
    const shared = sql`exists (
        select 1 from ${recordingFolderAssignments}
        join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        join ${users} org on org.id = ${recordingFolders.userId} and org.role = 'org'
        where ${recordingFolderAssignments.itemId} = ${chatterItems.id}
    )`;
    const rows = await executor.execute(sql`
        with sizes as (
            select ${recordings.userId} as user_id, ${recordings.filesize}::bigint as audio,
                0::bigint as mail, case when ${shared} then ${recordings.filesize}::bigint else 0 end as shared_audio,
                0::bigint as shared_mail
            from ${recordings} join ${chatterItems} on ${chatterItems.id} = ${recordings.id}
            where ${recordings.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${recordings.audioReapedAt} is null and ${recordings.downloadedAt} is not null
                and ${recordings.storagePath} <> ''
            union all
            select ${mailMessages.userId}, 0, ${mailMessages.sizeBytes}::bigint, 0,
                case when ${shared} then ${mailMessages.sizeBytes}::bigint else 0 end
            from ${mailMessages} join ${chatterItems} on ${chatterItems.id} = ${mailMessages.id}
            where ${mailMessages.deletedAt} is null and ${chatterItems.deletedAt} is null
                and ${mailMessages.rawReapedAt} is null and ${mailMessages.rawStoragePath} is not null
        ), totals as (
            select user_id, sum(audio) as audio, sum(mail) as mail,
                sum(shared_audio) as shared_audio, sum(shared_mail) as shared_mail
            from sizes group by user_id
        )
        insert into ${storageDailySnapshots} (user_id, day, audio_bytes, mail_bytes, shared_audio_bytes, shared_mail_bytes)
        select ${users.id}, (${at}::timestamp)::date, coalesce(t.audio, 0), coalesce(t.mail, 0),
            coalesce(t.shared_audio, 0), coalesce(t.shared_mail, 0)
        from ${users} left join totals t on t.user_id = ${users.id}
        order by ${users.id}
        on conflict (user_id, day) do update set audio_bytes = excluded.audio_bytes,
            mail_bytes = excluded.mail_bytes, shared_audio_bytes = excluded.shared_audio_bytes,
            shared_mail_bytes = excluded.shared_mail_bytes
        returning user_id
    `);
    return rows.length;
}
