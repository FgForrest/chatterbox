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
 * (`writer-rule.ts`). A row lives in the scope that made it: the owner's
 * on a private recording, the Organization's on a shared one. One
 * transcript can so carry both. A shared recording reads the
 * Organization's alone, the owner included: the owner's corrections that
 * sharing could not publish wait, unseen, and where the Organization's
 * cover the same words at withdrawal, the Organization's win
 * (`withdrawKnowledgeInTx`). A private recording reads the owner's.
 */

import { and, asc, eq, isNull, not, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptCorrections, transcriptions } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    type KnowledgeTarget,
    resolveTargetInTx,
    teachHeardAsInTx,
} from "@/lib/knowledge/aliases";
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
import {
    lockOrgPeopleShared,
    orgOwnedCondition,
    recordingSharedCondition,
} from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { lockTranscriptForChange } from "@/lib/knowledge/transcript-lock";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const HEARD_DOMAIN = "correction-heard";

/**
 * SQL predicate: the correction is in the scope a view of the transcript
 * reads: the Organization's while the recording is shared, the owner's
 * otherwise.
 */
function correctionsIn(ownerUserId: string, shared: boolean) {
    return shared
        ? orgOwnedCondition(transcriptCorrections.userId)
        : eq(transcriptCorrections.userId, ownerUserId);
}

/**
 * Whether the transcript's recording is shared, as this instance decides
 * it: never where it shows no Organization (a `local` instance keeps a
 * recording once shared in its folders, and its owner's view private).
 */
async function transcriptShared(
    executor: Pick<typeof db, "select">,
    transcriptionId: string,
): Promise<boolean> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return false;
    const [row] = await executor
        .select({ recordingId: transcriptions.recordingId })
        .from(transcriptions)
        .where(eq(transcriptions.id, transcriptionId))
        .limit(1);
    return row
        ? isRecordingShared(row.recordingId, orgUserId, executor)
        : false;
}

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
    /** One of the two is set. */
    targetPersonId: string | null;
    targetEntityId: string | null;
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
    target: KnowledgeTarget;
    /** Required for `correct`, ignored for `link`. */
    replacement?: string | null;
    /** Accepted by default in a review not yet finished (Phase 3). */
    preTicked?: boolean;
}

function correctionNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Correction not found", 404);
}

function invalid(message: string, field: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, { field });
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
 * or entity the actor may not see (404; the Organization's alone on a
 * shared recording, which only the organization account changes), or an
 * actor who may not change the recording now. A merged-away target
 * resolves to its survivor.
 *
 * A `correct` a person confirmed (not pre-ticked) also teaches how the
 * transcription heard the name (`teachHeardAsInTx`). Returns the id.
 */
export async function acceptCorrection(
    args: AcceptCorrectionArgs,
): Promise<string> {
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const id = await acceptCorrectionInTx(tx, args);
        await bumpScopeInTx(tx, [args.actorUserId]);
        return id;
    });
}

/**
 * `acceptCorrection` inside a caller's transaction, which took the
 * Organization-people lock (shared) first and bumps the actor's scope
 * once, last, with everything else it changed (a finished review).
 */
export async function acceptCorrectionInTx(
    tx: Tx,
    args: AcceptCorrectionArgs,
): Promise<string> {
    const { anchor, kind, actorUserId } = args;
    const replacement = cleanReplacement(kind, args.replacement, anchor.heard);
    const { revision, turns, language, provider } =
        await lockTranscriptForChange(tx, args, args);
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
                eq(transcriptCorrections.transcriptionId, args.transcriptionId),
                eq(transcriptCorrections.turnIndex, anchor.turnIndex),
                // Only what the actor's view shows, which the writer rule
                // made the actor's scope: a waiting private correction
                // neither blocks nor gives itself away.
                eq(transcriptCorrections.userId, actorUserId),
            ),
        );
    if (onTurn.some((other) => anchorsOverlap(other, anchor))) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "Those words already carry a correction",
            409,
        );
    }
    const target = await resolveTargetInTx(tx, actorUserId, args.target);
    const [row] = await tx
        .insert(transcriptCorrections)
        .values({
            // The writer rule made the actor the owner on a private
            // recording and the organization account on a shared one:
            // the scope.
            userId: actorUserId,
            transcriptionId: args.transcriptionId,
            transcriptRevision: revision,
            turnIndex: anchor.turnIndex,
            charStart: anchor.charStart,
            charEnd: anchor.charEnd,
            heard: encryptText(anchor.heard),
            heardHmac: domainLookupHash(HEARD_DOMAIN, anchor.heard),
            kind,
            targetPersonId: "personId" in target ? target.personId : null,
            targetEntityId: "entityId" in target ? target.entityId : null,
            replacement: replacement ? encryptText(replacement) : null,
            preTicked: args.preTicked ?? false,
            createdByUserId: actorUserId,
        })
        .returning({ id: transcriptCorrections.id });
    const id = (row as { id: string }).id;
    if (kind === "correct" && !args.preTicked) {
        await teachHeardAsInTx(tx, {
            scopeUserId: actorUserId,
            target,
            heard: anchor.heard,
            language,
            provider,
            correctionId: id,
        });
    }
    return id;
}

/**
 * Take a correction back: the row goes, and the transcript reads as it was
 * heard. Only the actor's scope: 404 alike for a missing correction,
 * another account's, and one the owner made before sharing (until sharing
 * publishes it).
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
                    eq(transcriptCorrections.userId, args.actorUserId),
                    eq(
                        transcriptCorrections.transcriptionId,
                        args.transcriptionId,
                    ),
                ),
            )
            .returning({ id: transcriptCorrections.id });
        if (deleted.length === 0) throw correctionNotFound();
        await bumpScopeInTx(tx, [args.actorUserId]);
    });
}

/**
 * The corrections on one of `ownerUserId`'s transcripts, in reading order:
 * on a shared recording the Organization's (for the owner too), on a
 * private one the owner's. An Organization-scope correction targets only
 * the Organization's people and entities, as the organization account sees
 * no others.
 */
export async function listCorrections(
    ownerUserId: string,
    transcriptionId: string,
    executor: Pick<typeof db, "select"> = db,
    {
        shared,
    }: {
        /**
         * The sharing state the reader was authorized in; looked up when
         * not given.
         */
        shared?: boolean;
    } = {},
): Promise<Correction[]> {
    const scope = shared ?? (await transcriptShared(executor, transcriptionId));
    const rows = await executor
        .select({
            id: transcriptCorrections.id,
            transcriptRevision: transcriptCorrections.transcriptRevision,
            turnIndex: transcriptCorrections.turnIndex,
            charStart: transcriptCorrections.charStart,
            charEnd: transcriptCorrections.charEnd,
            heard: transcriptCorrections.heard,
            kind: transcriptCorrections.kind,
            targetPersonId: transcriptCorrections.targetPersonId,
            targetEntityId: transcriptCorrections.targetEntityId,
            replacement: transcriptCorrections.replacement,
            preTicked: transcriptCorrections.preTicked,
        })
        .from(transcriptCorrections)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptCorrections.transcriptionId),
        )
        .where(
            and(
                eq(transcriptions.userId, ownerUserId),
                eq(transcriptCorrections.transcriptionId, transcriptionId),
                correctionsIn(ownerUserId, scope),
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

/**
 * The corrections on every transcript of `ownerUserId`'s live recordings,
 * each in the scope its view reads (`listCorrections`), in one query: an
 * export of everything. Per transcript, with whether its recording is
 * shared (so its links read the Organization's names).
 */
export async function listOwnersCorrections(
    ownerUserId: string,
): Promise<Map<string, { shared: boolean; corrections: Correction[] }>> {
    const orgUserId = await getOrgUserId();
    const shared = orgUserId
        ? recordingSharedCondition(recordings.id)
        : sql`false`;
    const rows = await db
        .select({
            transcriptionId: transcriptCorrections.transcriptionId,
            shared: sql<boolean>`${shared}`,
            id: transcriptCorrections.id,
            transcriptRevision: transcriptCorrections.transcriptRevision,
            turnIndex: transcriptCorrections.turnIndex,
            charStart: transcriptCorrections.charStart,
            charEnd: transcriptCorrections.charEnd,
            heard: transcriptCorrections.heard,
            kind: transcriptCorrections.kind,
            targetPersonId: transcriptCorrections.targetPersonId,
            targetEntityId: transcriptCorrections.targetEntityId,
            replacement: transcriptCorrections.replacement,
            preTicked: transcriptCorrections.preTicked,
        })
        .from(transcriptCorrections)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptCorrections.transcriptionId),
        )
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .where(
            and(
                eq(transcriptions.userId, ownerUserId),
                isNull(recordings.deletedAt),
                or(
                    and(
                        shared,
                        orgOwnedCondition(transcriptCorrections.userId),
                    ),
                    and(
                        not(shared),
                        eq(transcriptCorrections.userId, ownerUserId),
                    ),
                ),
            ),
        )
        .orderBy(
            asc(transcriptCorrections.transcriptionId),
            asc(transcriptCorrections.turnIndex),
            asc(transcriptCorrections.charStart),
        );
    const byTranscript = new Map<
        string,
        { shared: boolean; corrections: Correction[] }
    >();
    for (const { transcriptionId, shared: isShared, ...row } of rows) {
        const held = byTranscript.get(transcriptionId) ?? {
            shared: isShared,
            corrections: [],
        };
        held.corrections.push({
            ...row,
            heard: decryptText(row.heard),
            replacement: row.replacement ? decryptText(row.replacement) : null,
        });
        byTranscript.set(transcriptionId, held);
    }
    return byTranscript;
}
