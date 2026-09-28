/**
 * A person's answers about speaker labels.
 *
 * Kept apart from `attribution.ts` because answering can create a person:
 * the rest of that module is read by the summary and export paths, which
 * should not load the people knowledge base to do so.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { transcriptSpeakers } from "@/db/schema";
import {
    deleteSpeakerInTx,
    lockForSpeakerChange,
    rejectInTx,
    type TranscriptVersion,
    writeSpeakerInTx,
} from "@/lib/knowledge/attribution";
import { markSpeakerDependentEvidenceInTx } from "@/lib/knowledge/fact-evidence";
import { createPersonInTx } from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { contentWriterRefusal, writerRefusalError } from "@/lib/sharing/writer";

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
     * The organization account sharing is decided against
     * (`sharingOrgUserId`), or null when this instance shows none. Unless
     * the actor may change the recording now (`writerRefusal`) the change
     * is refused, under the recording lock sharing and withdrawal take:
     * 409 for the owner of a shared recording, 404 for the organization
     * account after a withdrawal.
     */
    orgUserId: string | null;
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
 * belongs to whoever names them: the owner's knowledge base on their own
 * recording, the Organization's on a shared one, which only the
 * organization account changes.
 */
export async function changeTranscriptSpeakerInTx(
    tx: Tx,
    args: SpeakerChangeArgs,
): Promise<string | null> {
    // The knowledge a change touched: a person it created, evidence it put
    // to review. Their scopes move once, last.
    const scopes = new Set<string>();
    const named = await answerSpeakerInTx(tx, args, scopes);
    await bumpScopeInTx(tx, scopes);
    return named;
}

async function answerSpeakerInTx(
    tx: Tx,
    { answer, actorUserId, orgUserId, ...version }: SpeakerChangeArgs,
    scopes: Set<string>,
): Promise<string | null> {
    const { recordingId } = await lockForSpeakerChange(tx, version);
    const refusal = await contentWriterRefusal(tx, {
        recordingId,
        ownerUserId: version.userId,
        actorUserId,
        orgUserId,
    });
    if (refusal) throw writerRefusalError(refusal);
    const where = {
        userId: version.userId,
        transcriptionId: version.transcriptionId,
        label: version.label,
    };
    // What the label answered before: facts that depend on who spoke there
    // go to review when that changes, and only then.
    const [before] = await tx
        .select({
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            markedUnknown: transcriptSpeakers.markedUnknown,
        })
        .from(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.transcriptionId, version.transcriptionId),
                eq(transcriptSpeakers.label, version.label),
            ),
        )
        .limit(1);
    const answered =
        before?.status === "confirmed"
            ? before.markedUnknown
                ? "unknown"
                : before.personId
            : null;
    const speakerChanged = async (now: string | null) => {
        if (answered !== null && answered !== now) {
            const marked = await markSpeakerDependentEvidenceInTx(tx, {
                transcriptionId: version.transcriptionId,
                label: version.label,
            });
            for (const scope of marked) scopes.add(scope);
        }
    };
    switch (answer.kind) {
        case "name": {
            let personId: string;
            if ("personId" in answer) {
                personId = answer.personId;
            } else {
                personId = (
                    await createPersonInTx(tx, {
                        userId: actorUserId,
                        displayName: answer.displayName,
                        createdByUserId: null,
                    })
                ).id;
                scopes.add(actorUserId);
            }
            await writeSpeakerInTx(tx, {
                ...where,
                personId,
                source: "user",
                status: "confirmed",
                confirmedByUserId: actorUserId,
            });
            await speakerChanged(personId);
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
            await speakerChanged("unknown");
            return null;
        case "clear":
            await deleteSpeakerInTx(tx, where);
            await speakerChanged(null);
            return null;
        case "reject":
            await rejectInTx(tx, { ...where, personId: answer.personId });
            return null;
    }
}
