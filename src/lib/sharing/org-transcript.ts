import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions, transcriptSpeakers } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { promotePerson } from "@/lib/knowledge/people";
import { isRecordingShared } from "@/lib/sharing/shared";

type TranscriptionRow = typeof transcriptions.$inferSelect;

export interface OrgTranscriptOwners {
    ownerUserId: string;
    /** The organization account, owner of the Organization view's rows. */
    contentUserId: string;
}

/**
 * The Organization view's own transcript for `source`, created on demand.
 *
 * Until someone edits it, the Organization view reads the owner's
 * transcripts. Naming a speaker there must not touch the owner's private
 * attributions, so the first edit copies the owner's transcripts -- every
 * source, so switching sources in the view keeps working -- into the
 * organization's rows, with the names already confirmed on them, and the
 * edit lands on the copy.
 *
 * Copies are inserted only where the organization has no row yet, under the
 * recording lock the content upserts take, so a concurrent Organization
 * re-transcription is never overwritten by the owner's older text.
 */
export async function ensureOrgTranscript(
    recordingId: string,
    source: string,
    owners: OrgTranscriptOwners,
    actorUserId: string,
): Promise<TranscriptionRow> {
    const findOwn = async () =>
        (
            await db
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
    if (existing) return existing;

    const copies = await db.transaction(async (tx) => {
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
            return null;
        }
        const originals = await tx
            .select()
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, owners.ownerUserId),
                ),
            );
        const made: { original: TranscriptionRow; copyId: string }[] = [];
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
                .returning({ id: transcriptions.id });
            if (copy) made.push({ original, copyId: copy.id });
        }
        return made;
    });
    if (copies === null) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    for (const { original, copyId } of copies) {
        const confirmed = await db
            .select()
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.transcriptionId, original.id),
                    eq(transcriptSpeakers.status, "confirmed"),
                ),
            );
        const rows = [];
        for (const attribution of confirmed) {
            // Only names the Organization knows travel; a private person
            // still on the owner's transcript is promoted first, which is
            // what showing it in the Organization view already implied.
            const personId = attribution.personId
                ? await promotePerson(
                      attribution.personId,
                      owners.contentUserId,
                  )
                : null;
            rows.push({
                userId: owners.contentUserId,
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
            await db
                .insert(transcriptSpeakers)
                .values(rows)
                .onConflictDoNothing();
        }
    }

    const own = await findOwn();
    if (!own) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }
    return own;
}
