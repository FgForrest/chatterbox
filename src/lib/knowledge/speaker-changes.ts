/**
 * A person's answers about speaker labels.
 *
 * Kept apart from `attribution.ts` because answering can create a person:
 * the rest of that module is read by the summary and export paths, which
 * should not load the people knowledge base to do so.
 */

import { db } from "@/db";
import {
    deleteSpeakerInTx,
    lockForSpeakerChange,
    rejectInTx,
    type TranscriptVersion,
    writeSpeakerInTx,
} from "@/lib/knowledge/attribution";
import { createPersonInTx } from "@/lib/knowledge/people";
import { recordingShared } from "@/lib/sharing/frozen";
import { isRecordingShared } from "@/lib/sharing/shared";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What a person said about one speaker label:
 * - `name`: it is this person, an existing one or a new name;
 * - `unknown`: nobody anyone knows, which is an answer;
 * - `clear`: take the answer back, and leave the label open;
 * - `reject`: it is not the suggested person, and never suggest them again.
 */
export type SpeakerAnswer =
    | { kind: "name"; personId: string }
    | { kind: "name"; displayName: string }
    | { kind: "unknown" }
    | { kind: "clear" }
    | { kind: "reject"; personId: string };

export interface SpeakerChangeArgs extends TranscriptVersion {
    label: string;
    answer: SpeakerAnswer;
    /** The human answering, recorded on what they confirm. */
    actorUserId: string;
    /**
     * The organization account, on a change to the owner's own transcript:
     * refused (409) while the recording is shared with it, as its private
     * copy is frozen. Checked under the recording lock sharing takes.
     */
    frozenWhileSharedWith?: string | null;
}

/**
 * Write one person's answer about one speaker label, as one transaction:
 * the transcript is locked and its revision checked before a new person is
 * created, so a refused change leaves nothing behind. Returns the person
 * named, if any.
 *
 * An answer is `confirmed` with source `user` and the person who gave it:
 * it came from a human looking at the transcript, the only evidence strong
 * enough to reach a summary or an export.
 */
export async function changeTranscriptSpeaker(
    args: SpeakerChangeArgs,
): Promise<string | null> {
    return db.transaction((tx) => changeTranscriptSpeakerInTx(tx, args));
}

/**
 * `changeTranscriptSpeaker` inside a caller's transaction. A new person
 * belongs to the transcript's owner, as their knowledge base names the
 * speakers of their transcripts.
 */
export async function changeTranscriptSpeakerInTx(
    tx: Tx,
    {
        answer,
        actorUserId,
        frozenWhileSharedWith,
        ...version
    }: SpeakerChangeArgs,
): Promise<string | null> {
    const { recordingId } = await lockForSpeakerChange(tx, version);
    if (
        frozenWhileSharedWith &&
        (await isRecordingShared(recordingId, frozenWhileSharedWith, tx))
    ) {
        throw recordingShared();
    }
    const where = {
        userId: version.userId,
        transcriptionId: version.transcriptionId,
        label: version.label,
    };
    switch (answer.kind) {
        case "name": {
            const personId =
                "personId" in answer
                    ? answer.personId
                    : (
                          await createPersonInTx(tx, {
                              userId: version.userId,
                              displayName: answer.displayName,
                              createdByUserId:
                                  actorUserId === version.userId
                                      ? null
                                      : actorUserId,
                          })
                      ).id;
            await writeSpeakerInTx(tx, {
                ...where,
                personId,
                source: "user",
                status: "confirmed",
                confirmedByUserId: actorUserId,
            });
            return personId;
        }
        case "unknown":
            await writeSpeakerInTx(tx, {
                ...where,
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: actorUserId,
            });
            return null;
        case "clear":
            await deleteSpeakerInTx(tx, where);
            return null;
        case "reject":
            await rejectInTx(tx, { ...where, personId: answer.personId });
            return null;
    }
}
