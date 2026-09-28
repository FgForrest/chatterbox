import { and, eq, inArray, isNotNull, not } from "drizzle-orm";
import type { db } from "@/db";
import { people, transcriptions, transcriptSpeakers } from "@/db/schema";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import { promotePersonInTx } from "@/lib/knowledge/people";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Make a recording's speaker names the Organization's, as it is shared.
 *
 * A shared recording is one recording, read by everyone in the
 * Organization, so every person confirmed on its transcripts becomes an
 * Organization person (`promotePersonInTx`: the same record, moved, or
 * folded into the Organization's person with the same email). Suggestions
 * naming someone who is still private are machine guesses the organization
 * account, which reviews suggestions, must not see; they go.
 *
 * The caller holds the Organization-people lock and then the recording
 * lock, in that order: a promotion may merge people, which locks the
 * recordings naming them. Returns how many people were promoted.
 */
export async function publishSpeakerNamesInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        orgUserId,
    }: { recordingId: string; ownerUserId: string; orgUserId: string },
): Promise<number> {
    const transcriptIds = (
        await tx
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, ownerUserId),
                ),
            )
    ).map((row) => row.id);
    if (transcriptIds.length === 0) return 0;

    const privatelyNamed = await tx
        .selectDistinct({ personId: transcriptSpeakers.personId })
        .from(transcriptSpeakers)
        .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                inArray(transcriptSpeakers.transcriptionId, transcriptIds),
                eq(transcriptSpeakers.status, "confirmed"),
                isNotNull(transcriptSpeakers.personId),
                not(orgOwnedCondition(people.userId)),
            ),
        );
    let promoted = 0;
    for (const { personId } of privatelyNamed) {
        if (!personId) continue;
        if (await promotePersonInTx(tx, personId, orgUserId)) promoted += 1;
    }

    const privateSuggestions = await tx
        .select({ id: transcriptSpeakers.id })
        .from(transcriptSpeakers)
        .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                inArray(transcriptSpeakers.transcriptionId, transcriptIds),
                eq(transcriptSpeakers.status, "suggested"),
                not(orgOwnedCondition(people.userId)),
            ),
        );
    if (privateSuggestions.length > 0) {
        await tx.delete(transcriptSpeakers).where(
            inArray(
                transcriptSpeakers.id,
                privateSuggestions.map((row) => row.id),
            ),
        );
    }
    return promoted;
}
