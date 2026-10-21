import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin, touchRecording } from "@/db/items";
import {
    aiEnhancements,
    asyncJobs,
    type ChatterItemKind,
    chatterItems,
    itemProcessing,
    mailContents,
    recordings,
    transcriptions,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { nudge } from "@/lib/jobs/nudge";
import { speakerVersionOf } from "@/lib/knowledge/speaker-label-rules";
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
import {
    stampNewTranscriptAudioInTx,
    transcriptRewrittenInTx,
} from "@/lib/knowledge/transcript-rewrite";
import { markSummaryStepDoneInTx, updatePhaseInTx } from "@/lib/pipeline/state";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import type { PipelineView } from "@/lib/pipeline/types";
import {
    contentWriterRefusal,
    contentWriterScope,
    sharingOrgUserId,
    type WriterRefusal,
} from "@/lib/sharing/writer";
import {
    dropReplaceableTaskReviewInTx,
    type TaskProposals,
    writeTaskProposalsInTx,
} from "@/lib/tasks/store";
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

export interface ProcessingRunInputs extends Record<string, unknown> {
    contentId: string;
    contentSourceId?: string;
    contentRevision: number | string;
    itemProfileRevisionId?: string | null;
}

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
     * The summary source made from the text this write replaces, deleted
     * with it in the same transaction, so it never outlives its text nor
     * goes after the writer lost the right to change the recording.
     */
    dropSummaryOnReplace?: EnhancementSource;
    /**
     * Who makes the change; defaults to `userId`. The owner or a vouched-for
     * Organization writer on a shared recording (see `writerRefusal`).
     */
    actorUserId?: string;
    /**
     * Whether the actor acts for the Organization (a curator, or the
     * organization account), re-checked by the run that writes.
     */
    actsForOrganization?: boolean;
    /** Account whose provider produced the text; defaults to the actor. */
    producedByUserId?: string;
    /** Immutable profile and input provenance for this provider run. */
    profileRevisionId?: string | null;
    builtinPromptsVersion?: string | null;
    payerUserId?: string | null;
    inputs?: ProcessingRunInputs | null;
    /**
     * The job this write finishes. Cancelled meanwhile (the recording was
     * withdrawn, erased or deleted), it writes nothing, even if the
     * recording is shared again by then.
     */
    /**
     * The md5 of the audio this text was made from, as read when its
     * transcription began (a sync may replace the audio meanwhile); the
     * recording's current one by default.
     */
    audioMd5?: string | null;
    jobId?: string;
    view?: PipelineView;
    /** Demo/restore writes remain on the synthesized legacy pipeline state. */
    pipeline?: "trigger" | "legacy";
}

export interface UpsertEnhancementArgs {
    /** The recording's owner, who owns its content rows. */
    userId: string;
    recordingId: string;
    /** The item's kind; a recording unless said otherwise. */
    kind?: ChatterItemKind;
    /** Transcript row this summary was generated from; null for mail. */
    transcriptionId: string | null;
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
    /**
     * `llmInputFingerprint` of what the model read; null (or absent) for a
     * summary nobody can tell stale, as an import. Written on every upsert.
     */
    inputFingerprint?: string | null;
    /** Permit an explicit user action to replace a deliberately erased summary. */
    allowReaped?: boolean;
    /** Who makes the change; defaults to `userId`. See `UpsertTranscriptionArgs`. */
    actorUserId?: string;
    /** See `UpsertTranscriptionArgs.actsForOrganization`. */
    actsForOrganization?: boolean;
    /** Account whose provider produced the summary; defaults to the actor. */
    producedByUserId?: string;
    /** Immutable profile, prompt, language and input provenance for this run. */
    profileRevisionId?: string | null;
    builtinPromptsVersion?: string | null;
    outputLanguage?: string | null;
    outputFormatLocale?: string | null;
    payerUserId?: string | null;
    inputs?: ProcessingRunInputs | null;
    /** See `UpsertTranscriptionArgs.jobId`. */
    jobId?: string;
    view?: PipelineView;
    /**
     * The task proposals the summary made, stored with it in its
     * transaction: they replace the ones its source made before.
     */
    tasks?: TaskProposals | null;
    /** Demo/restore writes remain on the synthesized legacy pipeline state. */
    pipeline?: "trigger" | "legacy";
}

/**
 * Result of a tombstone-aware upsert. `committed: false` means nothing was
 * written — callers should treat that as a skip, not a hard error:
 * - `reason: "shared"`: the recording is shared with the Organization and
 *   the actor is neither its owner nor an Organization writer;
 * - `reason: "withdrawn"`: an Organization change, and the recording is no
 *   longer shared;
 * - `reason: "cancelled"`: the job it finishes was cancelled meanwhile;
 * - otherwise it was soft-deleted mid-flight or its content erased (e.g.
 *   RECORDING_DELETED).
 */
export interface UpsertResult {
    committed: boolean;
    reason?: WriterRefusal | "cancelled" | "outdated";
}

const RECORDING_WRITE_BLOCKED = Symbol("recording-write-blocked");

class WriterRefused {
    constructor(readonly refusal: WriterRefusal | "cancelled") {}
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface CurrentFenceInput {
    contentId: string;
    contentSourceId: string;
    contentRevision: number;
    profileRevisionId: string | null;
}

async function currentFenceInput(
    tx: Tx,
    args: UpsertEnhancementArgs,
): Promise<CurrentFenceInput | null> {
    const [processing] = await tx
        .select({ profileRevisionId: itemProcessing.profileRevisionId })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, args.recordingId),
                eq(itemProcessing.userId, args.userId),
                eq(itemProcessing.view, args.view ?? "private"),
            ),
        )
        .limit(1);
    if (args.kind === "mail") {
        const [content] = await tx
            .select({ id: mailContents.id, revision: mailContents.revision })
            .from(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, args.recordingId),
                    eq(mailContents.userId, args.userId),
                ),
            )
            .limit(1);
        return content
            ? {
                  contentId: content.id,
                  contentSourceId: "mail",
                  contentRevision: content.revision,
                  profileRevisionId: processing?.profileRevisionId ?? null,
              }
            : null;
    }
    const source = args.inputs?.contentSourceId;
    if (source !== "riffado" && source !== "plaud" && source !== "mixed") {
        return null;
    }
    const [content] = await tx
        .select({ id: transcriptions.id, revision: transcriptions.revision })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, args.recordingId),
                eq(transcriptions.userId, args.userId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    return content
        ? {
              contentId: content.id,
              contentSourceId: source,
              contentRevision: content.revision,
              profileRevisionId: processing?.profileRevisionId ?? null,
          }
        : null;
}

function fenceMatches(
    inputs: ProcessingRunInputs,
    current: CurrentFenceInput | null,
): boolean {
    if (!current) return false;
    const sameContent =
        inputs.contentId === current.contentId &&
        inputs.contentSourceId === current.contentSourceId &&
        inputs.contentRevision === current.contentRevision;
    const sameProfile =
        !("itemProfileRevisionId" in inputs) ||
        inputs.itemProfileRevisionId === current.profileRevisionId;
    return sameContent && sameProfile;
}

/**
 * Whether the job a write finishes is still running. A cancellation marks
 * it failed under the same recording lock, so this is the job's state as of
 * that lock.
 */
async function jobStillRunning(tx: Tx, jobId: string): Promise<boolean> {
    const [job] = await tx
        .select({ status: asyncJobs.status })
        .from(asyncJobs)
        .where(eq(asyncJobs.id, jobId))
        .limit(1);
    return job?.status === "processing";
}

/**
 * Whether the actor acts for the Organization as the write lands: a claim
 * of `true` is re-checked against their current access. Resolved before
 * the transaction, since it may ask the identity provider while the
 * recording would be locked.
 */
async function curatesNow(
    args: { actsForOrganization?: boolean },
    actorUserId: string,
): Promise<boolean | undefined> {
    return args.actsForOrganization === true
        ? userCuratesOrganizationNow(actorUserId)
        : args.actsForOrganization;
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
    const actsForOrganization = await curatesNow(args, actorUserId);

    try {
        const advance = await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({
                    deletedAt: recordings.deletedAt,
                    transcriptReapedAt: chatterItems.contentReapedAt,
                })
                .from(recordings)
                .innerJoin(chatterItems, recordingItemJoin)
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
            // the actor's permission follows the current sharing state.
            const refusal = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
                actsForOrganization,
            });
            if (refusal) throw new WriterRefused(refusal);
            if (args.jobId && !(await jobStillRunning(tx, args.jobId))) {
                throw new WriterRefused("cancelled");
            }
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
            const runRecordColumns = {
                profileRevisionId: args.profileRevisionId ?? null,
                builtinPromptsVersion: args.builtinPromptsVersion ?? null,
                payerUserId: args.payerUserId ?? null,
                inputs: args.inputs ?? null,
            };

            if (current) {
                await tx
                    .update(transcriptions)
                    .set({
                        text: encryptedText,
                        turns: encryptedTurns,
                        // Anchored to the turns just replaced.
                        topics: null,
                        topicsInputFingerprint: null,
                        detectedLanguage,
                        transcriptionType,
                        provider,
                        model,
                        source,
                        producedByUserId,
                        ...runRecordColumns,
                        revision: sql`${transcriptions.revision} + 1`,
                    })
                    .where(
                        and(
                            eq(transcriptions.id, current.id),
                            eq(transcriptions.userId, userId),
                        ),
                    );
                // What was said about the text just replaced.
                await transcriptRewrittenInTx(tx, {
                    userId,
                    transcriptionId: current.id,
                    previous: storedSpeakerVersion(current),
                    next: speakerVersionOf({ source, model, text, turns }),
                    audioMd5: args.audioMd5,
                });
                if (args.dropSummaryOnReplace) {
                    await tx
                        .delete(aiEnhancements)
                        .where(
                            and(
                                eq(aiEnhancements.itemId, recordingId),
                                eq(aiEnhancements.userId, userId),
                                eq(
                                    aiEnhancements.source,
                                    args.dropSummaryOnReplace,
                                ),
                            ),
                        );
                    await dropReplaceableTaskReviewInTx(tx, {
                        recordingId,
                        ownerUserId: userId,
                    });
                }
            } else {
                await tx.insert(transcriptions).values({
                    recordingId,
                    userId,
                    text: encryptedText,
                    turns: encryptedTurns,
                    topics: null,
                    topicsInputFingerprint: null,
                    detectedLanguage,
                    transcriptionType,
                    provider,
                    model,
                    source,
                    producedByUserId,
                    ...runRecordColumns,
                });
                // Which audio it was made from, for a later rewrite.
                await stampNewTranscriptAudioInTx(tx, {
                    recordingId,
                    userId,
                    source: source,
                    audioMd5: args.audioMd5,
                });
            }

            const now = new Date();
            await touchRecording(tx, recordingId, userId, now);
            await tx
                .update(chatterItems)
                .set({ updatedAt: now, contentReapedAt: null })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                    ),
                );
            return args.pipeline === "legacy"
                ? null
                : requestAdvanceInTx(tx, {
                      itemId: recordingId,
                      userId,
                      view: args.view ?? "private",
                      reason: "transcript",
                  });
        });
        if (advance) nudge();
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
    const actsForOrganization = await curatesNow(args, actorUserId);

    const isMail = args.kind === "mail";

    try {
        const outcome = await db.transaction(async (tx) => {
            const [stillActive] = isMail
                ? await tx
                      .select({
                          deletedAt: chatterItems.deletedAt,
                          summaryReapedAt: chatterItems.summaryReapedAt,
                      })
                      .from(chatterItems)
                      .where(
                          and(
                              eq(chatterItems.id, recordingId),
                              eq(chatterItems.userId, userId),
                              eq(chatterItems.kind, "mail"),
                          ),
                      )
                      .for("update")
                      .limit(1)
                : await tx
                      .select({
                          deletedAt: recordings.deletedAt,
                          summaryReapedAt: chatterItems.summaryReapedAt,
                      })
                      .from(recordings)
                      .innerJoin(chatterItems, recordingItemJoin)
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
            const { refusal, scopeUserId } = await contentWriterScope(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
                actsForOrganization,
            });
            if (refusal) throw new WriterRefused(refusal);
            if (args.jobId && !(await jobStillRunning(tx, args.jobId))) {
                throw new WriterRefused("cancelled");
            }
            if (args.inputs?.contentSourceId) {
                const current = await currentFenceInput(tx, args);
                if (!fenceMatches(args.inputs, current)) {
                    const advance =
                        args.pipeline === "legacy"
                            ? null
                            : await requestAdvanceInTx(tx, {
                                  itemId: recordingId,
                                  userId,
                                  view: args.view ?? "private",
                                  reason: "summary",
                              });
                    if (advance && current) {
                        const profileChanged =
                            "itemProfileRevisionId" in args.inputs &&
                            args.inputs.itemProfileRevisionId !==
                                current.profileRevisionId;
                        await updatePhaseInTx(
                            tx,
                            recordingId,
                            args.view ?? "private",
                            userId,
                            "summary",
                            {
                                state: "outdated",
                                reason: profileChanged
                                    ? "profile_changed"
                                    : "content_changed",
                                generation: advance.requestedGeneration,
                                inputs: {
                                    contentId: current.contentId,
                                    contentSourceId: current.contentSourceId,
                                    contentRevision: current.contentRevision,
                                },
                                at: new Date().toISOString(),
                            },
                        );
                    }
                    return { advance, outdated: true };
                }
            }

            const [existing] = await tx
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, recordingId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, source),
                    ),
                )
                .limit(1);

            // Always written, NULL included -- see `multiPass` on the args.
            const multiPassColumns = {
                inputFingerprint: args.inputFingerprint ?? null,
                multiPassRounds: multiPass?.roundsRequested ?? null,
                multiPassUsed: multiPass?.passesUsed ?? null,
                multiPassMerged: multiPass?.merged ?? null,
            };
            const runRecordColumns = {
                profileRevisionId: args.profileRevisionId ?? null,
                builtinPromptsVersion: args.builtinPromptsVersion ?? null,
                outputLanguage: args.outputLanguage ?? null,
                outputFormatLocale: args.outputFormatLocale ?? null,
                payerUserId: args.payerUserId ?? null,
                inputs: args.inputs ?? null,
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
                        ...runRecordColumns,
                    })
                    .where(
                        and(
                            eq(aiEnhancements.id, existing.id),
                            eq(aiEnhancements.userId, userId),
                        ),
                    );
            } else {
                await tx.insert(aiEnhancements).values({
                    itemId: recordingId,
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
                    ...runRecordColumns,
                });
            }
            if (args.tasks) {
                await writeTaskProposalsInTx(tx, {
                    recordingId,
                    ownerUserId: userId,
                    actorUserId,
                    view:
                        orgUserId !== null && scopeUserId === orgUserId
                            ? "org"
                            : (args.view ?? "private"),
                    contentSourceId:
                        typeof args.inputs?.contentSourceId === "string"
                            ? args.inputs.contentSourceId
                            : null,
                    contentRevision:
                        typeof args.inputs?.contentRevision === "number"
                            ? args.inputs.contentRevision
                            : null,
                    proposals: args.tasks,
                });
            } else if (args.tasks === null && typeof tx.delete === "function") {
                await dropReplaceableTaskReviewInTx(tx, {
                    recordingId,
                    ownerUserId: userId,
                });
            }

            const now = new Date();
            if (!isMail) await touchRecording(tx, recordingId, userId, now);
            await tx
                .update(chatterItems)
                .set({ updatedAt: now, summaryReapedAt: null })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                    ),
                );
            const advance =
                args.pipeline === "legacy"
                    ? null
                    : await requestAdvanceInTx(tx, {
                          itemId: recordingId,
                          userId,
                          view: args.view ?? "private",
                          reason: "summary",
                      });
            if (
                advance &&
                args.inputs &&
                typeof args.inputs.contentSourceId === "string" &&
                typeof args.inputs.contentRevision === "number"
            ) {
                await markSummaryStepDoneInTx(tx, {
                    itemId: recordingId,
                    userId,
                    view: args.view ?? "private",
                    step: "summary",
                    content: {
                        contentId: args.inputs.contentId,
                        contentSourceId: args.inputs.contentSourceId,
                        contentRevision: args.inputs.contentRevision,
                    },
                    generation: advance.requestedGeneration,
                    inputFingerprint: args.inputFingerprint,
                    currentInputsVerified:
                        "itemProfileRevisionId" in args.inputs,
                });
            }
            return { advance, outdated: false };
        });
        if (outcome.advance) nudge();
        if (outcome.outdated) return { committed: false, reason: "outdated" };
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
