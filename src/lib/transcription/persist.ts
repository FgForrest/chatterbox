import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, recordings, transcriptions } from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { remapTranscriptAttributionsInTx } from "@/lib/knowledge/attribution";
import { speakerVersionOf } from "@/lib/knowledge/speaker-label-rules";
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
import {
    contentWriterRefusal,
    sharingOrgUserId,
    type WriterRefusal,
} from "@/lib/sharing/writer";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/**
 * Provenance of a transcript row, orthogonal to `transcriptionType`:
 *   - 'riffado' = produced by the user's own provider (server/browser)
 *   - 'plaud'   = imported from Plaud's native transcription
 *   - 'mixed'   = user-edited combination of the above
 * A recording can hold at most one row per source (enforced by the
 * `(recordingId, userId, source)` unique), so the sources coexist. See #204.
 */
export type TranscriptSource = "riffado" | "plaud" | "mixed";

/** Summary pipeline provenance. One row per source can coexist. */
export type EnhancementSource = "riffado" | "plaud";

export interface UpsertTranscriptionArgs {
    /** The recording's owner, who owns its content rows. */
    userId: string;
    recordingId: string;
    /** Plaintext transcript; this helper encrypts it at rest. */
    text: string;
    detectedLanguage: string | null;
    source: TranscriptSource;
    provider: string;
    model: string;
    /** Where it ran. Defaults to "server"; unrelated to `source`. */
    transcriptionType?: "server" | "browser";
    /**
     * Timed turns, encrypted at rest. Always written, including as
     * undefined, so a re-run without timings clears the previous run's turns
     * instead of leaving them beside text they no longer describe.
     */
    turns?: TranscriptTurn[];
    /** Permit an explicit user action to replace a deliberately erased transcript. */
    allowReaped?: boolean;
    /**
     * Who makes the change; defaults to `userId`. The organization account
     * on a shared recording, the owner otherwise (see `writerRefusal`).
     */
    actorUserId?: string;
    /** Account whose provider produced the text; defaults to the actor. */
    producedByUserId?: string;
}

export interface UpsertEnhancementArgs {
    /** The recording's owner, who owns its content rows. */
    userId: string;
    recordingId: string;
    /** Transcript row this summary was generated from. */
    transcriptionId: string;
    /** Plaintext summary; this helper encrypts it at rest. */
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    source: EnhancementSource;
    provider: string;
    model: string;
    /**
     * Multi-pass provenance, or undefined for a single-pass run.
     *
     * Written on every upsert, including as NULL: re-generating a
     * multi-pass summary in single-pass mode has to clear the old values,
     * or the row keeps claiming a provenance the current summary does not
     * have.
     */
    multiPass?: {
        roundsRequested: number;
        passesUsed: number;
        merged: boolean;
    };
    /** Permit an explicit user action to replace a deliberately erased summary. */
    allowReaped?: boolean;
    /** Who makes the change; defaults to `userId`. See `UpsertTranscriptionArgs`. */
    actorUserId?: string;
    /** Account whose provider produced the summary; defaults to the actor. */
    producedByUserId?: string;
}

/**
 * Result of a tombstone-aware upsert. `committed: false` means nothing was
 * written — callers should treat that as a skip, not a hard error:
 * - `reason: "shared"`: the recording is shared with the Organization and
 *   only the organization account changes it (RECORDING_SHARED);
 * - `reason: "withdrawn"`: an Organization change, and the recording is no
 *   longer shared;
 * - otherwise it was soft-deleted mid-flight or its content erased (e.g.
 *   RECORDING_DELETED).
 */
export interface UpsertResult {
    committed: boolean;
    reason?: WriterRefusal;
}

const RECORDING_WRITE_BLOCKED = Symbol("recording-write-blocked");

class WriterRefused {
    constructor(readonly refusal: WriterRefusal) {}
}

// Both upserts run inside a transaction that takes a row-level write lock
// (`FOR UPDATE`) on the recording and re-checks the soft-delete tombstone, so
// a concurrent DELETE can't be silently undone: either we see `deletedAt` set
// and abort, or our write commits before DELETE runs and DELETE then cleans up
// our row inside its own tx. Lifted verbatim from the transcribe + summary
// paths so all writers share one implementation. See PR #72.

/**
 * Insert-or-update the transcription row for `(recordingId, userId, source)`.
 * Source-scoped, so a Plaud-imported transcript and the user's own provider's
 * output upsert independently and coexist.
 */
export async function upsertTranscription(
    args: UpsertTranscriptionArgs,
): Promise<UpsertResult> {
    const {
        userId,
        recordingId,
        text,
        detectedLanguage,
        source,
        provider,
        model,
        transcriptionType = "server",
        turns,
        allowReaped = false,
    } = args;
    const actorUserId = args.actorUserId ?? userId;
    const producedByUserId = args.producedByUserId ?? actorUserId;
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();

    try {
        await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({
                    deletedAt: recordings.deletedAt,
                    transcriptReapedAt: recordings.transcriptReapedAt,
                })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                )
                .for("update")
                .limit(1);

            if (
                !stillActive ||
                stillActive.deletedAt ||
                (stillActive.transcriptReapedAt && !allowReaped)
            ) {
                throw RECORDING_WRITE_BLOCKED;
            }
            // From every writer: a provider run, a browser transcript, a
            // Plaud import. Under the lock sharing and withdrawal take, so
            // a run that began before either and ends after it writes
            // nothing.
            const refusal = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
            });
            if (refusal) throw new WriterRefused(refusal);

            const [current] = await tx
                .select({
                    id: transcriptions.id,
                    text: transcriptions.text,
                    turns: transcriptions.turns,
                    source: transcriptions.source,
                    model: transcriptions.model,
                })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                        eq(transcriptions.source, source),
                    ),
                )
                .limit(1);

            const encryptedText = encryptText(text);
            const encryptedTurns = turns?.length
                ? encryptJsonField(turns)
                : null;

            if (current) {
                await tx
                    .update(transcriptions)
                    .set({
                        text: encryptedText,
                        turns: encryptedTurns,
                        // Anchored to the turns just replaced.
                        topics: null,
                        detectedLanguage,
                        transcriptionType,
                        provider,
                        model,
                        source,
                        producedByUserId,
                        revision: sql`${transcriptions.revision} + 1`,
                    })
                    .where(
                        and(
                            eq(transcriptions.id, current.id),
                            eq(transcriptions.userId, userId),
                        ),
                    );
                // The speakers were named on the text just replaced.
                await remapTranscriptAttributionsInTx(tx, {
                    userId,
                    transcriptionId: current.id,
                    previous: storedSpeakerVersion(current),
                    next: speakerVersionOf({ source, model, text, turns }),
                });
            } else {
                await tx.insert(transcriptions).values({
                    recordingId,
                    userId,
                    text: encryptedText,
                    turns: encryptedTurns,
                    topics: null,
                    detectedLanguage,
                    transcriptionType,
                    provider,
                    model,
                    source,
                    producedByUserId,
                });
            }

            await tx
                .update(recordings)
                .set({
                    updatedAt: new Date(),
                    transcriptReapedAt: null,
                })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                );
        });
    } catch (txError) {
        if (txError === RECORDING_WRITE_BLOCKED) {
            return { committed: false };
        }
        if (txError instanceof WriterRefused) {
            return { committed: false, reason: txError.refusal };
        }
        throw txError;
    }

    return { committed: true };
}

/**
 * Insert-or-update the single AI summary row for `(recordingId, userId)`.
 * `source` records whether riffado generated it or it was imported from Plaud.
 */
export async function upsertEnhancement(
    args: UpsertEnhancementArgs,
): Promise<UpsertResult> {
    const {
        userId,
        recordingId,
        transcriptionId,
        summary,
        keyPoints,
        actionItems,
        source,
        provider,
        model,
        multiPass,
        allowReaped = false,
    } = args;
    const actorUserId = args.actorUserId ?? userId;
    const producedByUserId = args.producedByUserId ?? actorUserId;
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();

    try {
        await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({
                    deletedAt: recordings.deletedAt,
                    summaryReapedAt: recordings.summaryReapedAt,
                })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                )
                .for("update")
                .limit(1);

            if (
                !stillActive ||
                stillActive.deletedAt ||
                (stillActive.summaryReapedAt && !allowReaped)
            ) {
                throw RECORDING_WRITE_BLOCKED;
            }
            const refusal = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
            });
            if (refusal) throw new WriterRefused(refusal);

            const [existing] = await tx
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.recordingId, recordingId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, source),
                    ),
                )
                .limit(1);

            // Always written, NULL included -- see `multiPass` on the args.
            const multiPassColumns = {
                multiPassRounds: multiPass?.roundsRequested ?? null,
                multiPassUsed: multiPass?.passesUsed ?? null,
                multiPassMerged: multiPass?.merged ?? null,
            };

            const encryptedSummary = encryptText(summary);
            const encryptedKeyPoints = encryptJsonField(keyPoints);
            const encryptedActionItems = encryptJsonField(actionItems);

            if (existing) {
                await tx
                    .update(aiEnhancements)
                    .set({
                        summary: encryptedSummary,
                        keyPoints: encryptedKeyPoints,
                        actionItems: encryptedActionItems,
                        transcriptionId,
                        provider,
                        model,
                        source,
                        producedByUserId,
                        ...multiPassColumns,
                    })
                    .where(
                        and(
                            eq(aiEnhancements.id, existing.id),
                            eq(aiEnhancements.userId, userId),
                        ),
                    );
            } else {
                await tx.insert(aiEnhancements).values({
                    recordingId,
                    userId,
                    transcriptionId,
                    summary: encryptedSummary,
                    keyPoints: encryptedKeyPoints,
                    actionItems: encryptedActionItems,
                    provider,
                    model,
                    source,
                    producedByUserId,
                    ...multiPassColumns,
                });
            }

            await tx
                .update(recordings)
                .set({
                    updatedAt: new Date(),
                    summaryReapedAt: null,
                })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                );
        });
    } catch (txError) {
        if (txError === RECORDING_WRITE_BLOCKED) {
            return { committed: false };
        }
        if (txError instanceof WriterRefused) {
            return { committed: false, reason: txError.refusal };
        }
        throw txError;
    }

    return { committed: true };
}
