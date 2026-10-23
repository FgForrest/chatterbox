import type postgres from "postgres";

/** Warns operators before migration removes the frozen recording fields. */
export async function warnPendingRecordingColumnDrop(
    client: postgres.Sql,
): Promise<void> {
    const [row] = await client<{ pending: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'recordings'
              AND column_name IN (
                  'filename', 'start_time', 'title_edited_at', 'summary_due_at',
                  'transcript_reaped_at', 'summary_reaped_at', 'unshared_at'
              )
        ) AS pending
    `;
    if (row?.pending) {
        console.warn(
            "WARNING: This upgrade removes seven unused recordings columns. Titles, timestamps and retention markers live in chatter_items since migration 0096. Take a database dump before upgrading: rollback to an older image requires restoring that dump as well as the image.",
        );
    }
}
