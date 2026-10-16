/**
 * A person's answers about speaker labels.
 *
 * Kept apart from `attribution.ts` because answering can create a person:
 * the rest of that module is read by the summary and export paths, which
 * should not load the people knowledge base to do so.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { transcriptions, transcriptSpeakers } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { resolveTargetInTx } from "@/lib/knowledge/aliases";
import {
    deleteSpeakerInTx,
    lockForSpeakerChange,
    rejectInTx,
    type TranscriptVersion,
    writeSpeakerInTx,
} from "@/lib/knowledge/attribution";
import { markSpeakerDependentEvidenceInTx } from "@/lib/knowledge/fact-evidence";
import { lockOrgPeopleShared } from "@/lib/knowledge/org-people";
import { createPersonInTx } from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { contentWriterScope, writerRefusalError } from "@/lib/sharing/writer";

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
    /**
     * Whether the actor acts for the Organization (a curator the server
     * vouched for, or the organization account); left out, only the
     * organization account does.
     */
    actsForOrganization?: boolean;
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
    const named = await db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const result = await changeTranscriptSpeakerInTx(tx, args);
        const [transcript] = await tx
            .select({ recordingId: transcriptions.recordingId })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.id, args.transcriptionId),
                    eq(transcriptions.userId, args.userId),
                ),
            )
            .limit(1);
        if (!transcript) return result;
        await requestAdvanceInTx(tx, {
            itemId: transcript.recordingId,
            userId: args.userId,
            view:
                args.actsForOrganization || args.actorUserId === args.orgUserId
                    ? "org"
                    : "private",
            reason: "share-gate",
        });
        return result;
    });
    nudge();
    return named;
}

/**
 * `changeTranscriptSpeaker` inside a caller's transaction. A new person
 * belongs to the knowledge base the change writes into: the owner's on
 * their own recording, the Organization's on a shared one, where the
 * curator who named them is kept as its creator.
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

/**
 * The answer alone, inside a caller's transaction, which took the
 * Organization-people lock (shared) first: the scopes it touched are added
 * to `scopes`, for the caller to bump once, last (a finished review).
 */
export async function answerSpeakerInTx(
    tx: Tx,
    {
        answer,
        actorUserId,
        orgUserId,
        actsForOrganization,
        ...version
    }: SpeakerChangeArgs,
    scopes: Set<string>,
): Promise<string | null> {
    const { recordingId } = await lockForSpeakerChange(tx, version);
    const { refusal, scopeUserId } = await contentWriterScope(tx, {
        recordingId,
        ownerUserId: version.userId,
        actorUserId,
        orgUserId,
        actsForOrganization,
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
                personId = await currentPersonInTx(
                    tx,
                    scopeUserId,
                    answer.personId,
                );
            } else {
                personId = (
                    await createPersonInTx(tx, {
                        userId: scopeUserId,
                        displayName: answer.displayName,
                        createdByUserId:
                            scopeUserId === actorUserId ? null : actorUserId,
                    })
                ).id;
                scopes.add(scopeUserId);
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
            await rejectInTx(tx, {
                ...where,
                personId: await currentPersonInTx(
                    tx,
                    scopeUserId,
                    answer.personId,
                ),
            });
            return null;
    }
}

/**
 * The person an answer names, as they are now: one merged away since the
 * caller looked them up is the one they were folded into.
 */
async function currentPersonInTx(
    tx: Tx,
    actorUserId: string,
    personId: string,
): Promise<string> {
    const target = await resolveTargetInTx(tx, actorUserId, { personId });
    return "personId" in target ? target.personId : personId;
}
