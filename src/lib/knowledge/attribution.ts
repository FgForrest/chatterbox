import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
    people,
    recordings,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { mapLabels, remapAttributionRows } from "@/lib/knowledge/label-mapping";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import {
    type SpeakerVersion,
    speakerKey,
} from "@/lib/knowledge/speaker-label-rules";
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
import { isRecordingShared } from "@/lib/sharing/shared";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export type AttributionSource =
    | "user"
    | "calendar"
    | "meet"
    | "llm"
    | "heuristic";

export type AttributionStatus = "confirmed" | "suggested" | "rejected";

/** One speaker label of one transcript, and who it refers to. */
export interface TranscriptSpeaker {
    id: string;
    label: string;
    personId: string | null;
    personName: string | null;
    source: AttributionSource;
    status: AttributionStatus;
    confidence: number | null;
    evidenceStartMs: number | null;
    /** A person looked and said nobody known: an answer, not an open label. */
    markedUnknown: boolean;
    /** The human who confirmed the row; null on machine rows. */
    confirmedByUserId: string | null;
}

export interface SetTranscriptSpeakerArgs {
    userId: string;
    transcriptionId: string;
    /** The transcript revision the change was made on; see `lockForSpeakerChange`. */
    revision: number;
    label: string;
    personId: string | null;
    source: AttributionSource;
    status: AttributionStatus;
    confidence?: number | null;
    evidenceStartMs?: number | null;
    markedUnknown?: boolean;
    confirmedByUserId?: string | null;
}

/** One version of one user's transcript. */
export interface TranscriptVersion {
    userId: string;
    transcriptionId: string;
    revision: number;
}

/** One speaker label of one transcript. */
export interface TranscriptLabelArgs {
    userId: string;
    transcriptionId: string;
    /** The transcript revision the change was made on; see `lockForSpeakerChange`. */
    revision: number;
    label: string;
}

/** A suggestion a machine made, before it is filtered and written. */
export interface SuggestedSpeaker {
    label: string;
    personId: string | null;
    source: AttributionSource;
    confidence?: number | null;
    evidenceStartMs?: number | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface NameScopeOptions {
    /**
     * Name speakers with Organization people only. Set whenever the text is
     * read through the Organization view: it may be showing the owner's
     * transcript, whose attributions can still point at the owner's private
     * people, and those names are the owner's alone.
     */
    orgPeopleOnly?: boolean;
}

function namePeopleCondition(ownerId: string, options: NameScopeOptions) {
    return options.orgPeopleOnly
        ? orgOwnedCondition(people.userId)
        : or(eq(people.userId, ownerId), orgOwnedCondition(people.userId));
}

interface CopyMatchingSpeakerAttributionsArgs {
    userId: string;
    recordingId: string;
    /** The transcript whose confirmed names are offered, e.g. `plaud`. */
    sourceSource: string;
    /** The transcript they are offered on, e.g. `riffado`. */
    targetSource: string;
    /**
     * The organization account: nothing is offered while the recording is
     * shared with it, as the owner's copy is frozen.
     */
    frozenWhileSharedWith?: string | null;
}

/**
 * Offer the names confirmed on one transcript of a recording as suggestions
 * on another, e.g. from Plaud's transcript to the user's first own one.
 *
 * Two diarizers number the same voices independently, so labels are
 * matched by speech overlap like a re-transcription's (`mapLabels`), or by
 * speaking order when either transcript has no timings. Even a clean match
 * is only a suggestion here: the other diarizer may have split or merged
 * voices differently, and a person confirms. Only named rows travel, never
 * an "unknown", and a pair rejected on the target stays rejected. Returns
 * how many suggestions were written.
 */
export async function copyMatchingSpeakerAttributions({
    userId,
    recordingId,
    sourceSource,
    targetSource,
    frozenWhileSharedWith,
}: CopyMatchingSpeakerAttributionsArgs): Promise<number> {
    return db.transaction(async (tx) => {
        // Held against a concurrent rewrite of either transcript, which
        // locks the recording for update, and against a share.
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("share");
        if (
            frozenWhileSharedWith &&
            (await isRecordingShared(recordingId, frozenWhileSharedWith, tx))
        ) {
            return 0;
        }
        const rows = await tx
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
                    eq(transcriptions.userId, userId),
                    inArray(transcriptions.source, [
                        sourceSource,
                        targetSource,
                    ]),
                ),
            );
        const from = rows.find((row) => row.source === sourceSource);
        const to = rows.find((row) => row.source === targetSource);
        if (!from || !to || from.id === to.id) return 0;
        // Held like a speaker change holds it, so a rejection made meanwhile
        // is either seen below or made after these suggestions exist.
        await tx
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.id, to.id))
            .for("update");

        const previous = storedSpeakerVersion(from);
        const next = storedSpeakerVersion(to);
        const mapping = mapLabels(previous.turns, next.turns, {
            previousLabels: previous.labels,
            nextLabels: next.labels,
        });
        const named = await tx
            .select({
                label: transcriptSpeakers.label,
                personId: transcriptSpeakers.personId,
                status: transcriptSpeakers.status,
                source: transcriptSpeakers.source,
                markedUnknown: transcriptSpeakers.markedUnknown,
                confirmedByUserId: transcriptSpeakers.confirmedByUserId,
                confidence: transcriptSpeakers.confidence,
                evidenceStartMs: transcriptSpeakers.evidenceStartMs,
            })
            .from(transcriptSpeakers)
            .where(
                and(
                    eq(transcriptSpeakers.userId, userId),
                    eq(transcriptSpeakers.transcriptionId, from.id),
                    eq(transcriptSpeakers.status, "confirmed"),
                    eq(transcriptSpeakers.markedUnknown, false),
                    isNotNull(transcriptSpeakers.personId),
                ),
            );
        return insertSuggestionsInTx(tx, {
            userId,
            transcriptionId: to.id,
            rows: remapAttributionRows(named, mapping).map((row) => ({
                label: row.label,
                personId: row.personId,
                source: "heuristic" as const,
                confidence: row.confidence,
            })),
        });
    });
}

/**
 * Every attribution for one transcript, resolved names included.
 *
 * `ownerId` is the user the transcript belongs to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people` -- the owner's own, or the Organization's, which everyone
 * shares -- so a stored `personId` can never reach another account's.
 */
export async function getTranscriptSpeakers(
    ownerId: string,
    transcriptionId: string,
    options: NameScopeOptions = {},
): Promise<TranscriptSpeaker[]> {
    const rows = await db
        .select({
            id: transcriptSpeakers.id,
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            personName: people.displayName,
            source: transcriptSpeakers.source,
            status: transcriptSpeakers.status,
            confidence: transcriptSpeakers.confidence,
            evidenceStartMs: transcriptSpeakers.evidenceStartMs,
            markedUnknown: transcriptSpeakers.markedUnknown,
            confirmedByUserId: transcriptSpeakers.confirmedByUserId,
        })
        .from(transcriptSpeakers)
        .leftJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                namePeopleCondition(ownerId, options),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
            ),
        );

    return rows.map((row) => ({
        ...row,
        personName: row.personName ? decryptText(row.personName) : null,
    }));
}

/**
 * Hold the transcript still while a person changes one of its speakers, and
 * refuse the change if the text is no longer the version they looked at.
 *
 * Locks the recording (shared) and then the transcript (exclusive), the
 * same order a transcript write takes them, so a change and a
 * re-transcription never interleave: the change either lands before the
 * rewrite, which then moves it onto the new labels, or it sees the new
 * revision and is refused instead of naming a label that now means
 * someone else. Returns the recording it locked.
 */
export async function lockForSpeakerChange(
    tx: Tx,
    { userId, transcriptionId, revision }: TranscriptVersion,
): Promise<{ recordingId: string }> {
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
              .select({ revision: transcriptions.revision })
              .from(transcriptions)
              .where(
                  and(
                      eq(transcriptions.id, transcriptionId),
                      eq(transcriptions.userId, userId),
                  ),
              )
              .for("update")
        : [];
    if (!transcript) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }
    if (transcript.revision !== revision) throw transcriptChanged();
    return { recordingId: recording.id };
}

/** A change was made on a transcript version that is no longer the one shown. */
export function transcriptChanged(): AppError {
    return new AppError(
        ErrorCode.CONFLICT,
        "The transcript changed; reload",
        409,
    );
}

/**
 * Record who a speaker label refers to, replacing any previous answer for
 * that label.
 *
 * A correction is an ordinary update with nothing downstream to repair,
 * which is the whole benefit of attributing by name rather than by
 * voiceprint: there is no profile to poison, only a label to change.
 *
 * Naming a person a human once rejected for this label takes the rejection
 * back: the latest answer is the one that counts.
 */
export async function setTranscriptSpeaker(
    args: SetTranscriptSpeakerArgs,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockForSpeakerChange(tx, args);
        await writeSpeakerInTx(tx, args);
    });
}

/**
 * The row write of `setTranscriptSpeaker`. The caller holds
 * `lockForSpeakerChange`, and has checked the revision with it.
 */
export async function writeSpeakerInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        label,
        personId,
        source,
        status,
        confidence = null,
        evidenceStartMs = null,
        markedUnknown = false,
        confirmedByUserId = null,
    }: Omit<SetTranscriptSpeakerArgs, "revision">,
): Promise<void> {
    await tx
        .insert(transcriptSpeakers)
        .values({
            userId,
            transcriptionId,
            label,
            personId,
            source,
            status,
            confidence,
            evidenceStartMs,
            markedUnknown,
            confirmedByUserId,
        })
        .onConflictDoUpdate({
            target: [
                transcriptSpeakers.transcriptionId,
                transcriptSpeakers.label,
            ],
            set: {
                personId,
                source,
                status,
                confidence,
                evidenceStartMs,
                markedUnknown,
                confirmedByUserId,
                updatedAt: new Date(),
            },
        });
    if (personId && status === "confirmed") {
        await tx
            .delete(transcriptSpeakerRejections)
            .where(
                and(
                    eq(
                        transcriptSpeakerRejections.transcriptionId,
                        transcriptionId,
                    ),
                    eq(transcriptSpeakerRejections.label, label),
                    eq(transcriptSpeakerRejections.personId, personId),
                ),
            );
    }
}

/** Return a label to open: no name, no suggestion, no "unknown". */
export async function clearTranscriptSpeaker(
    args: TranscriptLabelArgs,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockForSpeakerChange(tx, args);
        await deleteSpeakerInTx(tx, args);
    });
}

/** The delete of `clearTranscriptSpeaker`; the caller holds the lock. */
export async function deleteSpeakerInTx(
    tx: Tx,
    { userId, transcriptionId, label }: Omit<TranscriptLabelArgs, "revision">,
): Promise<void> {
    await tx
        .delete(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.label, label),
            ),
        );
}

/**
 * Say a suggested person is not this speaker. The pair is remembered, so
 * the same suggestion is never offered again for this label, even after
 * other suggestions came and went.
 */
export async function rejectSuggestion(
    args: TranscriptLabelArgs & { personId: string },
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockForSpeakerChange(tx, args);
        await rejectInTx(tx, args);
    });
}

/** The writes of `rejectSuggestion`; the caller holds the lock. */
export async function rejectInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        label,
        personId,
    }: Omit<TranscriptLabelArgs, "revision"> & { personId: string },
): Promise<void> {
    await tx
        .insert(transcriptSpeakerRejections)
        .values({ userId, transcriptionId, label, personId })
        .onConflictDoNothing();
    await tx
        .delete(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.label, label),
                eq(transcriptSpeakers.personId, personId),
                eq(transcriptSpeakers.status, "suggested"),
            ),
        );
}

/**
 * Write machine suggestions for one transcript.
 *
 * A suggestion never overwrites anything: a label that already has a row,
 * whether a human's answer or an earlier suggestion, keeps it. A suggestion
 * without a person has nothing to offer, and a pair a human rejected stays
 * rejected. Returns how many were written.
 *
 * The caller holds the transcript `FOR UPDATE` (after its recording), as a
 * speaker change does, so a rejection cannot land between the read of the
 * rejections here and the insert.
 */
export async function insertSuggestionsInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        rows,
    }: {
        userId: string;
        transcriptionId: string;
        rows: readonly SuggestedSpeaker[];
    },
): Promise<number> {
    const named = rows.flatMap((row) =>
        row.personId
            ? [{ ...row, label: speakerKey(row.label), personId: row.personId }]
            : [],
    );
    if (named.length === 0) return 0;
    const rejected = await tx
        .select({
            label: transcriptSpeakerRejections.label,
            personId: transcriptSpeakerRejections.personId,
        })
        .from(transcriptSpeakerRejections)
        .where(
            eq(transcriptSpeakerRejections.transcriptionId, transcriptionId),
        );
    const rejectedPairs = new Set(
        rejected.map((row) => pairKey(row.label, row.personId)),
    );
    const allowed = named.filter(
        (row) => !rejectedPairs.has(pairKey(row.label, row.personId)),
    );
    if (allowed.length === 0) return 0;
    const inserted = await tx
        .insert(transcriptSpeakers)
        .values(
            allowed.map((row) => ({
                userId,
                transcriptionId,
                label: row.label,
                personId: row.personId,
                source: row.source,
                status: "suggested" as const,
                confidence: row.confidence ?? null,
                evidenceStartMs: row.evidenceStartMs ?? null,
            })),
        )
        .onConflictDoNothing()
        .returning({ id: transcriptSpeakers.id });
    return inserted.length;
}

/**
 * Move a transcript's speaker rows and rejections onto its new version.
 *
 * Called by every writer of transcript text or turns, in the transaction
 * that writes them, right after the write: the rows described labels of
 * the old text, and the new text may number the same voices differently.
 * Labels are matched by speech overlap (`mapLabels`). A clean match keeps
 * its row as it was; an uncertain one keeps only a name, as a suggestion.
 * A rejection moves only with a clean match: on an uncertain one it would
 * be about a voice nobody is sure of. Everything else is dropped.
 *
 * Speaker rows and rejections are selected by transcript: a transcript has
 * one owner, and the calling writer has already locked and checked it.
 *
 * Rarely this can deadlock with a share that is promoting the same people,
 * since both touch rows naming them. Postgres aborts one side: a job
 * retries on its own, and sharing retries once.
 */
export async function remapTranscriptAttributionsInTx(
    tx: Tx,
    {
        userId,
        transcriptionId,
        previous,
        next,
    }: {
        userId: string;
        transcriptionId: string;
        previous: SpeakerVersion;
        next: SpeakerVersion;
    },
): Promise<void> {
    const mapping = mapLabels(previous.turns, next.turns, {
        previousLabels: previous.labels,
        nextLabels: next.labels,
    });

    const rows = await tx
        .select({
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            source: transcriptSpeakers.source,
            markedUnknown: transcriptSpeakers.markedUnknown,
            confirmedByUserId: transcriptSpeakers.confirmedByUserId,
            confidence: transcriptSpeakers.confidence,
            evidenceStartMs: transcriptSpeakers.evidenceStartMs,
        })
        .from(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
            ),
        );
    const rejections = await tx
        .select({
            userId: transcriptSpeakerRejections.userId,
            label: transcriptSpeakerRejections.label,
            personId: transcriptSpeakerRejections.personId,
        })
        .from(transcriptSpeakerRejections)
        .where(
            eq(transcriptSpeakerRejections.transcriptionId, transcriptionId),
        );

    await tx
        .delete(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
            ),
        );
    if (rejections.length > 0) {
        await tx
            .delete(transcriptSpeakerRejections)
            .where(
                eq(
                    transcriptSpeakerRejections.transcriptionId,
                    transcriptionId,
                ),
            );
    }

    // Read after the deletes, which waited for any merge or deletion of
    // these people that had already touched the rows: a person merged away
    // meanwhile is written as the person kept, a deleted one not at all.
    const current = await currentPersonIds(tx, [
        ...rows.flatMap((row) => (row.personId ? [row.personId] : [])),
        ...rejections.map((rejection) => rejection.personId),
    ]);
    const movedRejections = rejections.flatMap((rejection) => {
        const label = mapping.carried.get(rejection.label);
        const personId = current.get(rejection.personId);
        return label && personId
            ? [{ ...rejection, label, personId, transcriptionId }]
            : [];
    });
    const rejected = new Set(
        movedRejections.map((row) => pairKey(row.label, row.personId)),
    );
    const remapped = remapAttributionRows(rows, mapping).flatMap((row) => {
        if (!row.personId) return [row];
        const personId = current.get(row.personId);
        if (!personId) return [];
        const ruledOut =
            row.status === "suggested" &&
            rejected.has(pairKey(row.label, personId));
        return ruledOut ? [] : [{ ...row, personId }];
    });

    if (remapped.length > 0) {
        await tx.insert(transcriptSpeakers).values(
            remapped.map((row) => ({
                ...row,
                userId,
                transcriptionId,
            })),
        );
    }
    if (movedRejections.length > 0) {
        // Two rejections on one label can now name the same person.
        await tx
            .insert(transcriptSpeakerRejections)
            .values(movedRejections)
            .onConflictDoNothing();
    }
}

/**
 * Where each person id points now: a merged-away id to the person it was
 * folded into (merges keep redirects one hop deep), a deleted one nowhere.
 */
async function currentPersonIds(
    tx: Tx,
    personIds: string[],
): Promise<Map<string, string>> {
    if (personIds.length === 0) return new Map();
    const rows = await tx
        .select({ id: people.id, mergedIntoId: people.mergedIntoId })
        .from(people)
        .where(inArray(people.id, [...new Set(personIds)]));
    return new Map(rows.map((row) => [row.id, row.mergedIntoId ?? row.id]));
}

function pairKey(label: string, personId: string): string {
    return `${label}\u0000${personId}`;
}

/**
 * Build the function that turns a raw speaker label into a display name.
 *
 * **Confirmed attributions only.** A suggested attribution renders in the UI
 * as a suggestion and never reaches transcript text, a summary prompt, an
 * export or the API: a machine guess that silently became the name on a
 * meeting minute is the failure this feature most needs to avoid, and
 * refusing to project it is what prevents that.
 *
 * Returns `undefined` when nobody is named, so `projectTranscript` serves the
 * stored text verbatim rather than re-rendering it from the turns for no gain.
 *
 * `ownerId` is the user the transcript belongs to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people`, so a stored `personId` can never reach across a tenant.
 */
export async function buildNameResolver(
    ownerId: string,
    transcriptionId: string,
    options: NameScopeOptions = {},
): Promise<SpeakerNameResolver | undefined> {
    const rows = await db
        .select({
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                namePeopleCondition(ownerId, options),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        );

    return rows.length > 0 ? namesFromRows(rows) : undefined;
}

/**
 * The resolver itself, separated from the query so the projection rule is
 * testable without a database.
 */
export function namesFromRows(
    rows: readonly { label: string; displayName: string }[],
): SpeakerNameResolver {
    const names = new Map(
        rows.map((row) => [
            speakerKey(row.label),
            decryptText(row.displayName),
        ]),
    );
    return (speaker: string) => names.get(speakerKey(speaker)) ?? null;
}

/** A resolver that names nobody, for transcripts with no attributions. */
export function emptyNameResolver(): SpeakerNameResolver {
    return () => null;
}
