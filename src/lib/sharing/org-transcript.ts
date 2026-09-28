import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions, transcriptSpeakers } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    changeTranscriptSpeakerInTx,
    type SpeakerAnswer,
    transcriptChanged,
} from "@/lib/knowledge/attribution";
import { lockOrgPeople, promotePersonInTx } from "@/lib/knowledge/people";
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
 * Until someone edits it, the Organization view reads the owner's
 * transcripts. Naming a speaker there must not touch the owner's private
 * attributions, so the first change copies the owner's transcripts into
 * the organization's rows, and the change lands on the copy.
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
    return db.transaction(async (tx) => {
        const target = await orgTranscriptForChangeInTx(tx, {
            recordingId,
            source,
            owners,
            actorUserId,
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
    });
}

/**
 * The Organization's own transcript for `source`, which the change must
 * have been made on, or, before the Organization has one, a copy of the
 * owner's made now.
 *
 * The copy covers every source, so switching sources in the view keeps
 * working, with the names already confirmed on them. It is made under the
 * recording lock the content upserts take, and only where the organization
 * has no row yet, so a concurrent Organization re-transcription is never
 * overwritten by the owner's older text.
 */
async function orgTranscriptForChangeInTx(
    tx: Tx,
    {
        recordingId,
        source,
        owners,
        actorUserId,
        seenId,
        seenRevision,
    }: {
        recordingId: string;
        source: string;
        owners: OrgTranscriptOwners;
        actorUserId: string;
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

    // Copying promotes people, and a promotion may merge them, which locks
    // the recordings naming them: the promotion lock comes first.
    await lockOrgPeople(tx);
    const [recording] = await tx
        .select({ deletedAt: recordings.deletedAt })
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
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    // Made while this request waited for the lock: not what was seen.
    if (await findOwn()) throw transcriptChanged();

    const originals = await tx
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, owners.ownerUserId),
            ),
        );
    const shown = originals.find((original) => original.source === source);
    if (!shown) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }
    if (shown.id !== seenId || shown.revision !== seenRevision) {
        throw transcriptChanged();
    }

    let target: TranscriptionRow | undefined;
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
        if (original.id === shown.id) target = copy;
    }
    if (!target) throw transcriptChanged();
    return target;
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
