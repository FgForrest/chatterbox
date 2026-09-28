import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Turn back into suggestions the speaker names an older release copied
 * from Plaud's transcript onto the user's own as if a person had confirmed
 * them.
 *
 * That copy mapped labels by speaker order and wrote `confirmed` rows, so
 * after `confirmed_by_user_id` arrived they look exactly like a person's
 * answer, and the share gate would count them. They are recognizable: a
 * confirmed row with a person and no confirmer, on a Riffado transcript,
 * whose recording's Plaud transcript has a confirmed row naming the same
 * person. Every such row is demoted; a few may be genuine confirmations,
 * which the owner accepts again with one click (decision D1 a).
 *
 * Idempotent: an accepted suggestion records its confirmer and no longer
 * matches. Returns how many rows were demoted.
 */
export async function demoteCopiedAttributions(): Promise<number> {
    const demoted = await db.execute<{ id: string }>(sql`
        UPDATE transcript_speakers AS copied
        SET status = 'suggested', source = 'heuristic', updated_at = now()
        FROM transcriptions AS own
        WHERE copied.transcription_id = own.id
          AND copied.status = 'confirmed'
          AND copied.confirmed_by_user_id IS NULL
          AND copied.person_id IS NOT NULL
          AND own.source = 'riffado'
          AND EXISTS (
              SELECT 1
              FROM transcriptions AS plaud
              JOIN transcript_speakers AS named
                ON named.transcription_id = plaud.id
              WHERE plaud.recording_id = own.recording_id
                AND plaud.user_id = own.user_id
                AND plaud.source = 'plaud'
                AND named.status = 'confirmed'
                AND named.person_id = copied.person_id
          )
        RETURNING copied.id
    `);
    return demoted.length;
}

/** Run the demotion once at startup; a failure only logs. */
export async function startLegacyAttributionDemotion(): Promise<void> {
    try {
        const count = await demoteCopiedAttributions();
        if (count > 0) {
            console.log(
                `[knowledge] turned ${count} copied speaker name(s) back into suggestions`,
            );
        }
    } catch (error) {
        console.error(
            "[knowledge] could not demote copied speaker names:",
            error,
        );
    }
}
