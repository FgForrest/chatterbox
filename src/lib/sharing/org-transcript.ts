import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { AppError, ErrorCode } from "@/lib/errors";
import { transcriptChanged } from "@/lib/knowledge/attribution";
import { lockOrgPeople, promotePersonInTx } from "@/lib/knowledge/people";
import {
    changeTranscriptSpeakerInTx,
    type SpeakerAnswer,
} from "@/lib/knowledge/speaker-changes";
import { isRecordingShared } from "@/lib/sharing/shared";

type TranscriptionRow = typeof transcriptions.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrgTranscriptOwners {
    ownerUserId: string;
    /** The organization account, owner of the Organization view's rows. */
    contentUserId: string;
}

export interface OrgSpeakerChangeArgs {
    recordingId: string;
    source: string;
    owners: OrgTranscriptOwners;
    /** The human answering. */
    actorUserId: string;
    /** The transcript the view showed, and its version. */
    seen: { transcriptionId: string; revision: number };
    label: string;
    answer: SpeakerAnswer;
}

/**
 * Change a speaker of the Organization view, in one transaction.
 *
 * The change lands on the Organization's own transcript, never on the
 * owner's private attributions. Sharing takes the Organization's copy; a
 * recording shared before that existed still shows the owner's
 * transcripts, and its first change takes the copy (the snapshot) and
 * lands on it.
 *
 * The change is refused (409) unless it was made on the transcript it
 * lands on: the Organization's own, or the owner's that is copied here. A
 * transcript the Organization made meanwhile, by a re-transcription or
 * another member's first change, is different text, whatever its revision.
 */
export async function changeOrgTranscriptSpeaker({
    recordingId,
    source,
    owners,
    actorUserId,
    seen,
    label,
    answer,
}: OrgSpeakerChangeArgs): Promise<{
    transcriptionId: string;
    revision: number;
    personId: string | null;
}> {
    // The snapshot a first change may take promotes, and so may merge,
    // people: the one deadlock that can meet, retried like the share's.
    return retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            const target = await orgTranscriptForChangeInTx(tx, {
                recordingId,
                source,
                owners,
                seenId: seen.transcriptionId,
                seenRevision: seen.revision,
            });
            const personId = await changeTranscriptSpeakerInTx(tx, {
                userId: owners.contentUserId,
                transcriptionId: target.id,
                revision: seen.revision,
                label,
                answer,
                actorUserId,
            });
            return {
                transcriptionId: target.id,
                revision: target.revision,
                personId,
            };
        }),
    );
}

/**
 * The Organization's own transcript for `source`, which the change must
 * have been made on, or, before the Organization has any, its copy of the
 * owner's, taken now by the snapshot.
 *
 * A recording shared before snapshots existed, and not yet reached by the
 * backfill, still shows the owner's transcripts here. The snapshot runs
 * under the recording lock the content upserts take, and copies only where
 * the organization has no row yet, so a concurrent Organization
 * re-transcription is never overwritten by the owner's older text.
 */
async function orgTranscriptForChangeInTx(
    tx: Tx,
    {
        recordingId,
        source,
        owners,
        seenId,
        seenRevision,
    }: {
        recordingId: string;
        source: string;
        owners: OrgTranscriptOwners;
        seenId: string;
        seenRevision: number;
    },
): Promise<TranscriptionRow> {
    const findOwn = async () =>
        (
            await tx
                .select()
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, owners.contentUserId),
                        eq(transcriptions.source, source),
                    ),
                )
                .limit(1)
        )[0];
    const existing = await findOwn();
    if (existing) {
        // Its revision is compared under its lock, by the change.
        if (existing.id !== seenId) throw transcriptChanged();
        return existing;
    }

    // The snapshot promotes people, and a promotion may merge them, which
    // locks the recordings naming them: the promotion lock comes first.
    await lockOrgPeople(tx);
    if (!(await lockSharedRecording(tx, recordingId, owners))) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    // Made while this request waited for the lock: not what was seen.
    if (await findOwn()) throw transcriptChanged();

    // The owner's content, copied: the owner produced it, as when sharing.
    const copies = await snapshotRecordingForOrgInTx(
        tx,
        recordingId,
        owners,
        owners.ownerUserId,
    );
    // The snapshot was taken before, and this transcript is not in it:
    // the Organization's copy was removed, and it is never taken again.
    if (!copies) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }
    const target = copies.get(seenId);
    // Copies were taken, but not of the text the change was made on.
    if (
        !target ||
        target.source !== source ||
        target.revision !== seenRevision
    ) {
        throw transcriptChanged();
    }
    return target;
}

/**
 * Lock the recording row, as the content upserts do, and say whether it is
 * still a live shared recording of `owners.ownerUserId`.
 */
async function lockSharedRecording(
    tx: Tx,
    recordingId: string,
    owners: OrgTranscriptOwners,
): Promise<{ orgSnapshotAt: Date | null } | null> {
    const [recording] = await tx
        .select({
            deletedAt: recordings.deletedAt,
            orgSnapshotAt: recordings.orgSnapshotAt,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, owners.ownerUserId),
            ),
        )
        .for("update")
        .limit(1);
    if (
        !recording ||
        recording.deletedAt ||
        !(await isRecordingShared(recordingId, owners.contentUserId, tx))
    ) {
        return null;
    }
    return { orgSnapshotAt: recording.orgSnapshotAt };
}

/**
 * Take the Organization's own copy of a shared recording, once.
 *
 * Copies every owner transcript the organization has no row of yet, with
 * its confirmed speaker names (people promoted as needed), and each owner
 * summary made from a transcript copied here; a summary tied to no
 * transcript is copied as it is. Then marks the recording, so nothing is
 * copied again until it is unshared: a transcript arriving later never
 * reaches the Organization ungated, and rows Organization retention removed
 * are never copied back. Existing Organization rows are left alone.
 *
 * The caller holds the Organization-people lock; the recording lock is
 * taken here. Does nothing, and returns null, unless the recording is,
 * under that lock, shared, not deleted, and not yet snapshotted. Otherwise
 * returns the copies made, by the id of the owner's transcript each one
 * copies, possibly none.
 */
export async function snapshotRecordingForOrgInTx(
    tx: Tx,
    recordingId: string,
    owners: OrgTranscriptOwners,
    actorUserId: string,
): Promise<Map<string, TranscriptionRow> | null> {
    const recording = await lockSharedRecording(tx, recordingId, owners);
    if (!recording || recording.orgSnapshotAt) return null;
    const copies = new Map<string, TranscriptionRow>();

    const originals = await tx
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, owners.ownerUserId),
            ),
        );
    for (const original of originals) {
        const [copy] = await tx
            .insert(transcriptions)
            .values({
                recordingId,
                userId: owners.contentUserId,
                text: original.text,
                turns: original.turns,
                // The same transcript, so its topics still fit it.
                topics: original.topics,
                detectedLanguage: original.detectedLanguage,
                transcriptionType: original.transcriptionType,
                provider: original.provider,
                model: original.model,
                source: original.source,
                producedByUserId: actorUserId,
                // The same text, so the same version of it.
                revision: original.revision,
            })
            .onConflictDoNothing()
            .returning();
        if (!copy) continue;
        await copyConfirmedSpeakersInTx(
            tx,
            original.id,
            copy.id,
            owners.contentUserId,
        );
        copies.set(original.id, copy);
    }

    const summaries = await tx
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, owners.ownerUserId),
            ),
        );
    for (const summary of summaries) {
        // A summary travels with the transcript it was made from; one made
        // from a transcript the Organization already had its own of would
        // describe other text.
        const transcriptionId =
            summary.transcriptionId === null
                ? null
                : copies.get(summary.transcriptionId)?.id;
        if (transcriptionId === undefined) continue;
        await tx
            .insert(aiEnhancements)
            .values({
                recordingId,
                userId: owners.contentUserId,
                transcriptionId,
                summary: summary.summary,
                actionItems: summary.actionItems,
                keyPoints: summary.keyPoints,
                provider: summary.provider,
                model: summary.model,
                source: summary.source,
                multiPassRounds: summary.multiPassRounds,
                multiPassUsed: summary.multiPassUsed,
                multiPassMerged: summary.multiPassMerged,
                producedByUserId: actorUserId,
            })
            .onConflictDoNothing();
    }

    await tx
        .update(recordings)
        .set({ orgSnapshotAt: new Date() })
        .where(eq(recordings.id, recordingId));
    return copies;
}

/**
 * Take the Organization's snapshot of a shared recording in a transaction
 * of its own, if it has none yet; the owner, who shared it, is recorded as
 * producing the copies. Returns whether it took one.
 *
 * For recordings shared before snapshots existed: the backfill, and an
 * Organization transcription, which must find the owner's names copied
 * before it writes, or its new transcript starts without them.
 */
export async function takeOrgSnapshot(
    recordingId: string,
    owners: OrgTranscriptOwners,
): Promise<boolean> {
    return retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            // Before the recording lock the snapshot takes: it promotes
            // people, which may merge them.
            await lockOrgPeople(tx);
            const copies = await snapshotRecordingForOrgInTx(
                tx,
                recordingId,
                owners,
                owners.ownerUserId,
            );
            return copies !== null;
        }),
    );
}

/**
 * Copy the names confirmed on one of the owner's transcripts onto the
 * Organization's copy of it. Only names the Organization knows travel; a
 * private person still on the owner's transcript is promoted first, which
 * is what showing it in the Organization view already implied.
 */
async function copyConfirmedSpeakersInTx(
    tx: Tx,
    originalId: string,
    copyId: string,
    orgUserId: string,
): Promise<void> {
    const confirmed = await tx
        .select()
        .from(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.transcriptionId, originalId),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        );
    const rows = [];
    for (const attribution of confirmed) {
        const personId = attribution.personId
            ? await promotePersonInTx(tx, attribution.personId, orgUserId)
            : null;
        // Named once, but the person is gone: nothing to carry.
        if (attribution.personId && !personId) continue;
        rows.push({
            userId: orgUserId,
            transcriptionId: copyId,
            label: attribution.label,
            personId,
            source: attribution.source,
            status: attribution.status,
            confidence: attribution.confidence,
            evidenceStartMs: attribution.evidenceStartMs,
            markedUnknown: attribution.markedUnknown,
            confirmedByUserId: attribution.confirmedByUserId,
        });
    }
    if (rows.length > 0) {
        await tx.insert(transcriptSpeakers).values(rows).onConflictDoNothing();
    }
}
