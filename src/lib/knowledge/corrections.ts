/**
 * Corrections accepted on a transcript: misheard names and terms put right
 * (`correct`), and nicknames or slang kept as spoken but pointed at who
 * they mean (`link`).
 *
 * An overlay: the stored transcript never changes, and reverting deletes
 * the row. Each correction is anchored to a turn and character offsets of
 * one transcript revision (`correction-anchors.ts`), and a rewrite of the
 * transcript re-anchors or drops it in the same transaction
 * (`correction-recheck.ts`).
 *
 * Corrections are the recording's content: while it is shared only the
 * organization account changes them, otherwise only its owner
 * (`writer-rule.ts`). Rows belong to the transcript's owner either way.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    people,
    recordings,
    transcriptCorrections,
    transcriptions,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    type TranscriptVersion,
    transcriptChanged,
} from "@/lib/knowledge/attribution";
import {
    anchorMatches,
    anchorsOverlap,
    type CorrectionAnchor,
} from "@/lib/knowledge/correction-anchors";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { orgOwnedCondition, peopleVisibleTo } from "@/lib/knowledge/people";
import { contentWriterRefusal, writerRefusalError } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { TranscriptTurn } from "@/lib/transcription/turns";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const HEARD_DOMAIN = "correction-heard";
/** Long enough for any name or term, short enough to keep it one. */
const MAX_REPLACEMENT_LENGTH = 200;

export type CorrectionKind = "correct" | "link";

export interface Correction {
    id: string;
    transcriptRevision: number;
    turnIndex: number;
    charStart: number;
    charEnd: number;
    heard: string;
    kind: CorrectionKind;
    targetPersonId: string;
    /** Null on a link, which shows the target's current name. */
    replacement: string | null;
    preTicked: boolean;
}

interface Writer {
    /** The human accepting or reverting, recorded on what they accept. */
    actorUserId: string;
    /**
     * The organization account sharing is decided against
     * (`sharingOrgUserId`), or null when this instance shows none.
     */
    orgUserId: string | null;
}

export interface AcceptCorrectionArgs extends TranscriptVersion, Writer {
    anchor: CorrectionAnchor;
    kind: CorrectionKind;
    targetPersonId: string;
    /** Required for `correct`, ignored for `link`. */
    replacement?: string | null;
    /** Accepted by default in a review not yet finished (Phase 3). */
    preTicked?: boolean;
}

function correctionNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Correction not found", 404);
}

function personNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
}

function invalid(message: string, field: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, { field });
}

/**
 * Lock a transcript for a change to its corrections, after its recording
 * (the lock sharing and withdrawal take), and check the writer rule under
 * it. Returns the transcript's revision and turns. 404 alike for a missing
 * transcript and another account's.
 */
async function lockTranscriptForChange(
    tx: Tx,
    { userId, transcriptionId }: Omit<TranscriptVersion, "revision">,
    { actorUserId, orgUserId }: Writer,
): Promise<{ revision: number; turns: TranscriptTurn[] | null }> {
    const [recording] = await tx
        .select({ id: recordings.id })
        .from(recordings)
        .innerJoin(
            transcriptions,
            eq(transcriptions.recordingId, recordings.id),
        )
        .where(
            and(
                eq(transcriptions.id, transcriptionId),
                eq(transcriptions.userId, userId),
            ),
        )
        .for("share", { of: recordings });
    const [transcript] = recording
        ? await tx
              .select({
                  revision: transcriptions.revision,
                  turns: transcriptions.turns,
              })
              .from(transcriptions)
              .where(
                  and(
                      eq(transcriptions.id, transcriptionId),
                      eq(transcriptions.userId, userId),
                  ),
              )
              .for("update")
        : [];
    if (!recording || !transcript) {
        throw new AppError(ErrorCode.NOT_FOUND, "Transcript not found", 404);
    }
    const refusal = await contentWriterRefusal(tx, {
        recordingId: recording.id,
        ownerUserId: userId,
        actorUserId,
        orgUserId,
    });
    if (refusal) throw writerRefusalError(refusal);
    return {
        revision: transcript.revision,
        turns: readTranscriptTurns(transcript),
    };
}

/**
 * The person a correction may target: one the actor may see, which on a
 * shared recording (the organization account acting) is an Organization
 * person. A merged-away id resolves to the person it was folded into.
 */
async function resolveTarget(
    tx: Tx,
    actorUserId: string,
    personId: string,
): Promise<string> {
    for (let id = personId, hops = 0; hops < 2; hops++) {
        const [person] = await tx
            .select({ id: people.id, mergedIntoId: people.mergedIntoId })
            .from(people)
            .where(and(eq(people.id, id), peopleVisibleTo(actorUserId)))
            .limit(1);
        if (!person) break;
        if (!person.mergedIntoId) return person.id;
        id = person.mergedIntoId;
    }
    throw personNotFound();
}

function cleanReplacement(
    kind: CorrectionKind,
    replacement: string | null | undefined,
    heard: string,
): string | null {
    if (kind === "link") return null;
    const clean = replacement?.trim().normalize("NFC") ?? "";
    if (!clean) {
        throw invalid("A correction needs its replacement", "replacement");
    }
    if (clean.length > MAX_REPLACEMENT_LENGTH) {
        throw invalid("The replacement is too long", "replacement");
    }
    if (clean === heard) {
        throw invalid("The replacement is what was heard", "replacement");
    }
    return clean;
}

/**
 * Accept one correction on the transcript revision the person was looking
 * at. Refused, with nothing written: a changed transcript (409), words not
 * at the anchor (400), words already carrying a correction (409), a person
 * the actor may not see (404), or an actor who may not change the
 * recording now. Returns the correction's id.
 */
export async function acceptCorrection(
    args: AcceptCorrectionArgs,
): Promise<string> {
    const { anchor, kind, actorUserId } = args;
    const replacement = cleanReplacement(kind, args.replacement, anchor.heard);
    return db.transaction(async (tx) => {
        const { revision, turns } = await lockTranscriptForChange(
            tx,
            args,
            args,
        );
        if (revision !== args.revision) throw transcriptChanged();
        if (!anchorMatches(anchor, turns)) {
            throw invalid("Those words are not at that place", "anchor");
        }
        const onTurn = await tx
            .select({
                turnIndex: transcriptCorrections.turnIndex,
                charStart: transcriptCorrections.charStart,
                charEnd: transcriptCorrections.charEnd,
            })
            .from(transcriptCorrections)
            .where(
                and(
                    eq(
                        transcriptCorrections.transcriptionId,
                        args.transcriptionId,
                    ),
                    eq(transcriptCorrections.turnIndex, anchor.turnIndex),
                ),
            );
        if (onTurn.some((other) => anchorsOverlap(other, anchor))) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Those words already carry a correction",
                409,
            );
        }
        const targetPersonId = await resolveTarget(
            tx,
            actorUserId,
            args.targetPersonId,
        );
        const [row] = await tx
            .insert(transcriptCorrections)
            .values({
                userId: args.userId,
                transcriptionId: args.transcriptionId,
                transcriptRevision: revision,
                turnIndex: anchor.turnIndex,
                charStart: anchor.charStart,
                charEnd: anchor.charEnd,
                heard: encryptText(anchor.heard),
                heardHmac: domainLookupHash(HEARD_DOMAIN, anchor.heard),
                kind,
                targetPersonId,
                replacement: replacement ? encryptText(replacement) : null,
                preTicked: args.preTicked ?? false,
                createdByUserId: actorUserId,
            })
            .returning({ id: transcriptCorrections.id });
        return (row as { id: string }).id;
    });
}

/**
 * Take a correction back: the row goes, and the transcript reads as it was
 * heard. 404 alike for a missing correction and another account's.
 */
export async function revertCorrection(
    args: Omit<TranscriptVersion, "revision"> &
        Writer & { correctionId: string },
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockTranscriptForChange(tx, args, args);
        const deleted = await tx
            .delete(transcriptCorrections)
            .where(
                and(
                    eq(transcriptCorrections.id, args.correctionId),
                    eq(transcriptCorrections.userId, args.userId),
                    eq(
                        transcriptCorrections.transcriptionId,
                        args.transcriptionId,
                    ),
                ),
            )
            .returning({ id: transcriptCorrections.id });
        if (deleted.length === 0) throw correctionNotFound();
    });
}

/**
 * The corrections on one of `ownerUserId`'s transcripts, in reading order.
 * `orgPeopleOnly` on the Organization view: corrections targeting the
 * owner's private people are the owner's alone.
 */
export async function listCorrections(
    ownerUserId: string,
    transcriptionId: string,
    { orgPeopleOnly = false }: { orgPeopleOnly?: boolean } = {},
): Promise<Correction[]> {
    const rows = await db
        .select({
            id: transcriptCorrections.id,
            transcriptRevision: transcriptCorrections.transcriptRevision,
            turnIndex: transcriptCorrections.turnIndex,
            charStart: transcriptCorrections.charStart,
            charEnd: transcriptCorrections.charEnd,
            heard: transcriptCorrections.heard,
            kind: transcriptCorrections.kind,
            targetPersonId: transcriptCorrections.targetPersonId,
            replacement: transcriptCorrections.replacement,
            preTicked: transcriptCorrections.preTicked,
        })
        .from(transcriptCorrections)
        .innerJoin(people, eq(people.id, transcriptCorrections.targetPersonId))
        .where(
            and(
                eq(transcriptCorrections.userId, ownerUserId),
                eq(transcriptCorrections.transcriptionId, transcriptionId),
                orgPeopleOnly ? orgOwnedCondition(people.userId) : undefined,
            ),
        )
        .orderBy(
            asc(transcriptCorrections.turnIndex),
            asc(transcriptCorrections.charStart),
        );
    return rows.map((row) => ({
        ...row,
        heard: decryptText(row.heard),
        replacement: row.replacement ? decryptText(row.replacement) : null,
    }));
}
