/**
 * The corrections half of the transcript rewrite hook
 * (`transcript-rewrite.ts`).
 *
 * Apart from `corrections.ts` because the transcript writers load it, and
 * the summary path loads them: nothing here may validate the environment.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { transcriptCorrections, transcriptions } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    type AnchorPosition,
    remapCorrectionAnchors,
} from "@/lib/knowledge/correction-anchors";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import type { TranscriptTurn } from "@/lib/transcription/turns";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Carry a transcript's corrections onto its new version, in the
 * transaction that wrote it (`transcriptRewrittenInTx`).
 *
 * Every scope's: the owner's and the Organization's can sit on one
 * transcript. Pre-ticked rows go: the review that ticked them was about the
 * text just replaced. The rest are re-anchored (`remapCorrectionAnchors`)
 * and moved to the new revision, or deleted where their words are not
 * found exactly. Returns the scopes it touched.
 */
export async function recheckCorrectionsInTx(
    tx: Tx,
    {
        transcriptionId,
        previousTurns,
        nextTurns,
    }: {
        transcriptionId: string;
        previousTurns: readonly TranscriptTurn[] | null;
        nextTurns: readonly TranscriptTurn[] | null;
    },
): Promise<Set<string>> {
    const ofTranscript = eq(
        transcriptCorrections.transcriptionId,
        transcriptionId,
    );
    const preTicked = await tx
        .delete(transcriptCorrections)
        .where(and(ofTranscript, eq(transcriptCorrections.preTicked, true)))
        .returning({ userId: transcriptCorrections.userId });
    const rows = await tx
        .select({
            id: transcriptCorrections.id,
            userId: transcriptCorrections.userId,
            turnIndex: transcriptCorrections.turnIndex,
            charStart: transcriptCorrections.charStart,
            charEnd: transcriptCorrections.charEnd,
            heard: transcriptCorrections.heard,
        })
        .from(transcriptCorrections)
        .where(ofTranscript)
        .orderBy(
            // Where two land on the same words the first keeps them: the
            // Organization's, which a shared recording shows, before the
            // owner's waiting ones.
            desc(orgOwnedCondition(transcriptCorrections.userId)),
            asc(transcriptCorrections.turnIndex),
            asc(transcriptCorrections.charStart),
            asc(transcriptCorrections.createdAt),
        );
    const scopes = new Set([...preTicked, ...rows].map((row) => row.userId));
    if (rows.length === 0) return scopes;

    const positions = remapCorrectionAnchors(
        rows.map((row) => ({ ...row, heard: decryptText(row.heard) })),
        previousTurns,
        nextTurns,
    );
    const lost = rows.filter((_, index) => !positions[index]);
    if (lost.length > 0) {
        await tx.delete(transcriptCorrections).where(
            inArray(
                transcriptCorrections.id,
                lost.map((row) => row.id),
            ),
        );
    }
    if (lost.length === rows.length) return scopes;

    const [transcript] = await tx
        .select({ revision: transcriptions.revision })
        .from(transcriptions)
        .where(eq(transcriptions.id, transcriptionId));
    const revision = transcript?.revision ?? 0;
    for (const [index, row] of rows.entries()) {
        const position = positions[index] as AnchorPosition | null;
        if (!position) continue;
        await tx
            .update(transcriptCorrections)
            .set({
                ...position,
                transcriptRevision: revision,
                updatedAt: new Date(),
            })
            .where(eq(transcriptCorrections.id, row.id));
    }
    return scopes;
}
