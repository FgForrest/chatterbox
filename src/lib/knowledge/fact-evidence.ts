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
    transcriptCorrections,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { deleteFactsInTx } from "@/lib/knowledge/fact-chains";
import {
    QUOTE_SIMILARITY_THRESHOLD,
    quoteFromTurns,
    quoteSimilarity,
} from "@/lib/knowledge/fact-rules";
import { mapLabels } from "@/lib/knowledge/label-mapping";
import type { SpeakerVersion } from "@/lib/knowledge/speaker-label-rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What knowledge sits on a recording's transcripts, read before they go:
 * the facts with evidence there, and every scope whose evidence,
 * corrections or heard-as forms (which go with their corrections) the
 * delete takes.
 */
export async function knowledgeOnRecordingInTx(
    tx: Tx,
    recordingId: string,
): Promise<{ factIds: string[]; scopes: Set<string> }> {
    const evidence = await tx
        .selectDistinct({
            factId: knowledgeFactEvidence.factId,
            userId: knowledgeFactEvidence.userId,
        })
        .from(knowledgeFactEvidence)
        .where(eq(knowledgeFactEvidence.recordingId, recordingId));
    const corrections = await tx
        .selectDistinct({ userId: transcriptCorrections.userId })
        .from(transcriptCorrections)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptCorrections.transcriptionId),
        )
        .where(eq(transcriptions.recordingId, recordingId));
    return {
        factIds: [...new Set(evidence.map((row) => row.factId))],
        scopes: new Set([...evidence, ...corrections].map((row) => row.userId)),
    };
}

/**
 * Delete the facts among `factIds` that came from recordings and have no
 * evidence left: decay. Facts a person entered by hand stay. A fact one of
 * them replaced is current again when it was the newest: the last value
 * still said somewhere (`deleteFactsInTx` keeps the chain whole).
 *
 * Evidence under review keeps its fact stored, so the review can move or
 * drop it; only facts with some `supported` evidence are shown and used.
 */
export async function pruneUnsupportedFactsInTx(
    tx: Tx,
    factIds: readonly string[],
): Promise<void> {
    if (factIds.length === 0) return;
    const unsupported = await tx
        .select({ id: knowledgeFacts.id })
        .from(knowledgeFacts)
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
    await deleteFactsInTx(
        tx,
        unsupported.map((row) => row.id),
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
): Promise<Set<string>> {
    const marked = await tx
        .update(knowledgeFactEvidence)
        .set({ status: "speaker_changed" })
        .where(
            and(
                eq(knowledgeFactEvidence.transcriptionId, transcriptionId),
                eq(knowledgeFactEvidence.speakerLabel, label),
                eq(knowledgeFactEvidence.dependsOnSpeaker, true),
                eq(knowledgeFactEvidence.status, "supported"),
            ),
        )
        .returning({ userId: knowledgeFactEvidence.userId });
    return new Set(marked.map((row) => row.userId));
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
 * Returns the scopes it touched.
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
): Promise<Set<string>> {
    const rows = await tx
        .select({
            id: knowledgeFactEvidence.id,
            userId: knowledgeFactEvidence.userId,
            status: knowledgeFactEvidence.status,
            startMs: knowledgeFactEvidence.startMs,
            endMs: knowledgeFactEvidence.endMs,
            quote: knowledgeFactEvidence.quote,
            speakerLabel: knowledgeFactEvidence.speakerLabel,
            dependsOnSpeaker: knowledgeFactEvidence.dependsOnSpeaker,
        })
        .from(knowledgeFactEvidence)
        .where(eq(knowledgeFactEvidence.transcriptionId, transcriptionId));
    if (rows.length === 0) return new Set();

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
    return new Set(rows.map((row) => row.userId));
}
