import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    people,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import { lockOrgPeople, promotePersonInTx } from "@/lib/knowledge/people";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";
import { getOrgUserId } from "@/lib/org/config";
import {
    isRecordingShared,
    sharedRecordingCondition,
} from "@/lib/sharing/shared";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Make a recording's speaker names the Organization's, as it is shared.
 *
 * A shared recording is one recording, read by everyone in the
 * Organization, so every person confirmed on its transcripts becomes an
 * Organization person (`promotePersonInTx`: the same record, moved, or
 * folded into the Organization's person with the same email). Suggestions
 * naming someone who is still private are machine guesses the organization
 * account, which reviews suggestions, must not see; they go. So do rows on
 * labels the text no longer has: nobody sees them, the gate never judged
 * them, and a private person on one must not be published by it.
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
    const transcripts = await tx
        .select({
            id: transcriptions.id,
            source: transcriptions.source,
            model: transcriptions.model,
            text: transcriptions.text,
            turns: transcriptions.turns,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, ownerUserId),
            ),
        );
    if (transcripts.length === 0) return 0;
    // The labels each text has now, as the gate reads them.
    const current = new Map(
        transcripts.map((transcript) => [
            transcript.id,
            new Set(transcriptSpeakerLabels(transcript)),
        ]),
    );

    const rows = await tx
        .select({
            id: transcriptSpeakers.id,
            transcriptionId: transcriptSpeakers.transcriptionId,
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            orgPerson: sql<boolean>`coalesce(${orgOwnedCondition(people.userId)}, false)`,
        })
        .from(transcriptSpeakers)
        .leftJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            inArray(
                transcriptSpeakers.transcriptionId,
                transcripts.map((transcript) => transcript.id),
            ),
        );

    const dropped: string[] = [];
    const toPromote = new Set<string>();
    for (const row of rows) {
        if (!current.get(row.transcriptionId)?.has(row.label)) {
            dropped.push(row.id);
        } else if (!row.personId || row.orgPerson) {
            // Nobody named, or somebody the Organization knows already.
        } else if (row.status === "confirmed") {
            toPromote.add(row.personId);
        } else {
            dropped.push(row.id);
        }
    }
    if (dropped.length > 0) {
        await tx
            .delete(transcriptSpeakers)
            .where(inArray(transcriptSpeakers.id, dropped));
    }
    let promoted = 0;
    for (const personId of toPromote) {
        if (await promotePersonInTx(tx, personId, orgUserId)) promoted += 1;
    }
    return promoted;
}

/**
 * Hold what sharing establishes: every person named on a shared recording
 * is the Organization's, and no suggestion there names someone private.
 *
 * In steady state this finds nothing: sharing publishes the names, and
 * while shared only the organization account, which names only
 * Organization people, changes the recording. It repairs what an older
 * release left, when an owner could still name people on a recording
 * after sharing it. One cheap query when there is nothing to do; each
 * repair under the share's locks, re-checked. Returns how many recordings
 * it repaired.
 */
export async function repairSharedSpeakerNames(): Promise<number> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return 0;
    const found = await db
        .selectDistinct({ id: recordings.id, ownerUserId: recordings.userId })
        .from(transcriptSpeakers)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptSpeakers.transcriptionId),
        )
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                eq(transcriptions.userId, recordings.userId),
                isNull(recordings.deletedAt),
                inArray(transcriptSpeakers.status, ["confirmed", "suggested"]),
                sharedRecordingCondition(orgUserId),
                not(orgOwnedCondition(people.userId)),
            ),
        );
    let repaired = 0;
    for (const recording of found) {
        try {
            const published = await retryOnDeadlock(() =>
                db.transaction(async (tx) => {
                    // The share's order: a promotion may merge people,
                    // which locks the recordings naming them.
                    await lockOrgPeople(tx);
                    await tx
                        .select({ id: recordings.id })
                        .from(recordings)
                        .where(eq(recordings.id, recording.id))
                        .for("update");
                    if (
                        !(await isRecordingShared(recording.id, orgUserId, tx))
                    ) {
                        return false;
                    }
                    await publishSpeakerNamesInTx(tx, {
                        recordingId: recording.id,
                        ownerUserId: recording.ownerUserId,
                        orgUserId,
                    });
                    return true;
                }),
            );
            if (published) repaired += 1;
        } catch (error) {
            console.error(
                `[shared-names] could not repair recording ${recording.id}:`,
                error,
            );
        }
    }
    return repaired;
}

let repairStarted = false;

/** Run the repair once, in the background, at startup. */
export function startSharedSpeakerNamesRepair(): void {
    if (repairStarted) return;
    repairStarted = true;
    void repairSharedSpeakerNames()
        .then((repaired) => {
            if (repaired > 0) {
                console.log(
                    `[shared-names] published the names of ${repaired} shared recording(s)`,
                );
            }
        })
        .catch((error) => {
            console.error("[shared-names] repair failed:", error);
        });
}
