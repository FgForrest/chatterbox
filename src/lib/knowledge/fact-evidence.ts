/**
 * The evidence side of facts: what happens to it when its transcript is
 * rewritten or goes, or when the speaker it depends on changes, and the
 * facts left with none.
 *
 * Apart from `facts.ts` because the transcript writers, retention, erase
 * and the recording DELETE load it: nothing here may validate the
 * environment.
 */

import { and, eq, inArray, notExists } from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeFactEvidence,
    knowledgeFacts,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    QUOTE_SIMILARITY_THRESHOLD,
    quoteFromTurns,
    quoteSimilarity,
} from "@/lib/knowledge/fact-rules";
import { mapLabels } from "@/lib/knowledge/label-mapping";
import type { SpeakerVersion } from "@/lib/knowledge/speaker-label-rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The facts with evidence on a recording's transcripts, read before they go. */
export async function factsEvidencedOnInTx(
    tx: Tx,
    recordingId: string,
): Promise<string[]> {
    const rows = await tx
        .selectDistinct({ factId: knowledgeFactEvidence.factId })
        .from(knowledgeFactEvidence)
        .where(eq(knowledgeFactEvidence.recordingId, recordingId));
    return rows.map((row) => row.factId);
}

/**
 * Delete the facts among `factIds` that came from recordings and have no
 * evidence left: decay. Facts a person entered by hand stay. A fact one of
 * them replaced is current again (`replacedByFactId` goes null): the last
 * value still said somewhere.
 *
 * Evidence under review keeps its fact stored, so the review can move or
 * drop it; only facts with some `supported` evidence are shown and used.
 */
export async function pruneUnsupportedFactsInTx(
    tx: Tx,
    factIds: readonly string[],
): Promise<void> {
    if (factIds.length === 0) return;
    await tx
        .delete(knowledgeFacts)
        .where(
            and(
                inArray(knowledgeFacts.id, [...factIds]),
                eq(knowledgeFacts.origin, "recording"),
                notExists(
                    tx
                        .select({ id: knowledgeFactEvidence.id })
                        .from(knowledgeFactEvidence)
                        .where(
                            eq(knowledgeFactEvidence.factId, knowledgeFacts.id),
                        ),
                ),
            ),
        );
}

/**
 * A speaker label now names someone else, nobody, or nobody known: the
 * supported evidence that depends on who spoke there goes to review
 * (`speaker_changed`), to be moved to the new person or dropped. Never
 * moved silently.
 */
export async function markSpeakerDependentEvidenceInTx(
    tx: Tx,
    { transcriptionId, label }: { transcriptionId: string; label: string },
): Promise<void> {
    await tx
        .update(knowledgeFactEvidence)
        .set({ status: "speaker_changed" })
        .where(
            and(
                eq(knowledgeFactEvidence.transcriptionId, transcriptionId),
                eq(knowledgeFactEvidence.speakerLabel, label),
                eq(knowledgeFactEvidence.dependsOnSpeaker, true),
                eq(knowledgeFactEvidence.status, "supported"),
            ),
        );
}

/**
 * Carry a transcript's evidence onto its new version, in the transaction
 * that wrote it (`transcriptRewrittenInTx`), for every scope.
 *
 * Supported evidence stays supported while the words at its time are still
 * alike (`quoteSimilarity`) and, when it depends on a speaker, that
 * speaker's label carries cleanly (`mapLabels`); otherwise it goes to
 * review as `wording_changed` or `speaker_changed`. Evidence already under
 * review keeps its status, its label following the voice where it can.
 */
export async function recheckEvidenceInTx(
    tx: Tx,
    {
        transcriptionId,
        previous,
        next,
    }: {
        transcriptionId: string;
        previous: SpeakerVersion;
        next: SpeakerVersion;
    },
): Promise<void> {
    const rows = await tx
        .select({
            id: knowledgeFactEvidence.id,
            status: knowledgeFactEvidence.status,
            startMs: knowledgeFactEvidence.startMs,
            endMs: knowledgeFactEvidence.endMs,
            quote: knowledgeFactEvidence.quote,
            speakerLabel: knowledgeFactEvidence.speakerLabel,
            dependsOnSpeaker: knowledgeFactEvidence.dependsOnSpeaker,
        })
        .from(knowledgeFactEvidence)
        .where(eq(knowledgeFactEvidence.transcriptionId, transcriptionId));
    if (rows.length === 0) return;

    const [transcript] = await tx
        .select({ revision: transcriptions.revision })
        .from(transcriptions)
        .where(eq(transcriptions.id, transcriptionId));
    const revision = transcript?.revision ?? 0;
    const mapping = mapLabels(previous.turns, next.turns, {
        previousLabels: previous.labels,
        nextLabels: next.labels,
    });

    for (const row of rows) {
        const carried = row.speakerLabel
            ? mapping.carried.get(row.speakerLabel)
            : undefined;
        let status = row.status;
        if (status === "supported") {
            const cut = quoteFromTurns(next.turns, row.startMs, row.endMs);
            if (
                !cut ||
                quoteSimilarity(decryptText(row.quote), cut) <
                    QUOTE_SIMILARITY_THRESHOLD
            ) {
                status = "wording_changed";
            } else if (row.dependsOnSpeaker && !carried) {
                status = "speaker_changed";
            }
        }
        await tx
            .update(knowledgeFactEvidence)
            .set({
                status,
                speakerLabel: carried ?? row.speakerLabel,
                transcriptRevision: revision,
            })
            .where(eq(knowledgeFactEvidence.id, row.id));
    }
}
