import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    chatterItems,
    recordings,
    summaryRemarks,
    transcriptions,
    users,
} from "@/db/schema";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { exportRecordingSidecarsIfEnabled } from "@/lib/export/document-sidecars";
import { speakerLabelsForTranscript } from "@/lib/knowledge/speaker-label-rules";
import {
    inferSummarySpeakerNumberOffset,
    storedSummarySpeakerNumberOffset,
    storeEditedSpeakerReferences,
} from "@/lib/knowledge/speaker-references";
import type { ReadableRecordingViewContext } from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    assertMayChange,
    contentWriterRefusal,
    recordingGone,
    writerRefusalError,
} from "@/lib/sharing/writer";
import {
    type StoredSummary,
    storedSummaryOf,
} from "@/lib/summary/read-summary";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SummaryRemark {
    id: string;
    text: string;
    authorUserId: string | null;
    authorName: string | null;
    createdAt: string;
}

/** Require the owner acting in their own view for summary corrections. */
export function assertSummaryOwner(
    access: ReadableRecordingViewContext,
    actorUserId: string,
): void {
    if (access.view !== "private" || access.ownerUserId !== actorUserId)
        throw recordingGone();
    assertMayChange(access, actorUserId, false);
}

/** Serialize summary edits with item erasure, sharing, transcription and model writes. */
export async function withSummaryOwnerWrite<T>(
    access: ReadableRecordingViewContext,
    actorUserId: string,
    itemId: string,
    write: (tx: Tx) => Promise<T>,
): Promise<T> {
    assertSummaryOwner(access, actorUserId);
    return db.transaction(async (tx) => {
        const [locked] =
            access.kind === "mail"
                ? await tx
                      .select({ deletedAt: chatterItems.deletedAt })
                      .from(chatterItems)
                      .where(
                          and(
                              eq(chatterItems.id, itemId),
                              eq(chatterItems.userId, actorUserId),
                          ),
                      )
                      .for("update")
                      .limit(1)
                : await tx
                      .select({ deletedAt: recordings.deletedAt })
                      .from(recordings)
                      .where(
                          and(
                              eq(recordings.id, itemId),
                              eq(recordings.userId, actorUserId),
                          ),
                      )
                      .for("update")
                      .limit(1);
        if (!locked || locked.deletedAt) throw recordingGone();
        const refusal = await contentWriterRefusal(tx, {
            recordingId: itemId,
            ownerUserId: actorUserId,
            actorUserId,
            orgUserId: access.orgUserId,
            actsForOrganization: false,
        });
        if (refusal) throw writerRefusalError(refusal);
        return write(tx);
    });
}

/** Save only summary prose and key points; task state and generation inputs stay intact. */
export async function editSummary(input: {
    access: ReadableRecordingViewContext;
    actorUserId: string;
    itemId: string;
    summary: string;
    keyPoints: string[];
    revision: number;
    summaryId: string;
}): Promise<StoredSummary> {
    const saved = await withSummaryOwnerWrite(
        input.access,
        input.actorUserId,
        input.itemId,
        async (tx) => {
            const [current] = await tx
                .select()
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.id, input.summaryId),
                        eq(aiEnhancements.itemId, input.itemId),
                        eq(aiEnhancements.userId, input.actorUserId),
                        eq(aiEnhancements.source, "riffado"),
                        eq(aiEnhancements.revision, input.revision),
                    ),
                )
                .limit(1);
            if (!current)
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The summary changed. Your draft is kept. Reload before trying again.",
                    409,
                );
            let speakerNumberOffset = storedSummarySpeakerNumberOffset(
                current.inputs,
            );
            if (speakerNumberOffset === null) {
                const [transcript] = current.transcriptionId
                    ? await tx
                          .select()
                          .from(transcriptions)
                          .where(
                              and(
                                  eq(
                                      transcriptions.id,
                                      current.transcriptionId,
                                  ),
                                  eq(transcriptions.userId, input.actorUserId),
                                  eq(transcriptions.recordingId, input.itemId),
                              ),
                          )
                          .limit(1)
                    : [];
                speakerNumberOffset = inferSummarySpeakerNumberOffset(
                    [
                        decryptText(current.summary) ?? "",
                        ...(decryptJsonField<string[]>(current.keyPoints) ??
                            []),
                        ...(decryptJsonField<string[]>(current.actionItems) ??
                            []),
                    ].join("\n"),
                    transcript
                        ? speakerLabelsForTranscript({
                              ...transcript,
                              text: decryptText(transcript.text),
                              turns: readTranscriptTurns(transcript),
                          })
                        : [],
                );
            }
            const [saved] = await tx
                .update(aiEnhancements)
                .set({
                    summary: encryptText(
                        storeEditedSpeakerReferences(input.summary),
                    ),
                    keyPoints: encryptJsonField(
                        input.keyPoints.map(storeEditedSpeakerReferences),
                    ),
                    inputs: { ...current.inputs, speakerNumberOffset },
                    editedAt: new Date(),
                    editedByUserId: input.actorUserId,
                    revision: input.revision + 1,
                })
                .where(
                    and(
                        eq(aiEnhancements.id, input.summaryId),
                        eq(aiEnhancements.itemId, input.itemId),
                        eq(aiEnhancements.userId, input.actorUserId),
                        eq(aiEnhancements.source, "riffado"),
                        eq(aiEnhancements.revision, input.revision),
                    ),
                )
                .returning();
            if (!saved)
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The summary changed. Reload before editing it again.",
                    409,
                );
            await touchSummaryItem(
                tx,
                input.actorUserId,
                input.itemId,
                input.access.kind,
            );
            return saved;
        },
    );
    await exportRecordingSidecarsIfEnabled(
        input.actorUserId,
        input.itemId,
        "summary",
        "riffado",
    );
    await notifyIfShared(input.itemId);
    return storedSummaryOf(saved);
}

async function touchSummaryItem(
    tx: Tx,
    userId: string,
    itemId: string,
    kind: string,
) {
    const now = new Date();
    await tx
        .update(chatterItems)
        .set({ updatedAt: now })
        .where(
            and(eq(chatterItems.id, itemId), eq(chatterItems.userId, userId)),
        );
    if (kind === "audio")
        await tx
            .update(recordings)
            .set({ updatedAt: now })
            .where(
                and(eq(recordings.id, itemId), eq(recordings.userId, userId)),
            );
}

/** Read owner-scoped remarks only after the caller's write access has been checked. */
export async function readSummaryRemarks(
    userId: string,
    itemId: string,
    executor: Tx | typeof db = db,
): Promise<SummaryRemark[]> {
    const rows = await executor
        .select({
            id: summaryRemarks.id,
            text: summaryRemarks.text,
            authorUserId: summaryRemarks.authorUserId,
            authorName: users.name,
            createdAt: summaryRemarks.createdAt,
        })
        .from(summaryRemarks)
        .leftJoin(users, eq(users.id, summaryRemarks.authorUserId))
        .where(
            and(
                eq(summaryRemarks.userId, userId),
                eq(summaryRemarks.itemId, itemId),
            ),
        )
        .orderBy(asc(summaryRemarks.createdAt), asc(summaryRemarks.id));
    return rows.map((row) => ({
        ...row,
        text: decryptText(row.text) ?? "",
        createdAt: row.createdAt.toISOString(),
    }));
}
