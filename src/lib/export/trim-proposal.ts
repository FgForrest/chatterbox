import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { itemProcessing, recordings, transcriptions } from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import type { PhaseRecord } from "@/lib/pipeline/types";
import type { StoredTrimProposal } from "@/lib/recordings/trim-proposal";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

export interface ArchivedTrimProposal {
    ownerUserId: string;
    inputDigest?: string;
    recordingId: string;
    proposal: Omit<StoredTrimProposal, "inputFingerprint"> | null;
    marker: Pick<
        PhaseRecord,
        "state" | "reason" | "inputs" | "at" | "profileRevisionId"
    > | null;
}

/** Collect owner-private decisions only for full personal archives. */
export async function collectTrimProposals(
    scope: ArchiveScope,
    recordingIds: string[],
): Promise<ArchivedTrimProposal[]> {
    if (scope.kind !== "personal" || !recordingIds.length) return [];
    const rows = await db
        .select({
            id: recordings.id,
            proposal: recordings.trimProposal,
            phases: itemProcessing.phases,
        })
        .from(recordings)
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, recordings.id),
                eq(itemProcessing.userId, scope.userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .where(
            and(
                eq(recordings.userId, scope.userId),
                inArray(recordings.id, recordingIds),
                isNull(recordings.deletedAt),
            ),
        );
    const archived = rows.flatMap((row) => {
        const stored = decryptJsonField<StoredTrimProposal>(row.proposal);
        const phase = row.phases?.trim;
        if (!stored && !phase) return [];
        const proposal = stored
            ? (({ inputFingerprint: _fingerprint, ...portable }) => portable)(
                  stored,
              )
            : null;
        return [
            {
                recordingId: row.id,
                ownerUserId: scope.userId,
                proposal,
                marker: phase
                    ? {
                          state: phase.state,
                          reason: phase.reason,
                          inputs: phase.inputs,
                          at: phase.at,
                          profileRevisionId: phase.profileRevisionId,
                      }
                    : null,
            },
        ];
    });
    return Promise.all(
        archived.map(async (entry) => {
            if (!entry.proposal) return entry;
            const [transcript] = await db
                .select()
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.id, entry.proposal.transcript.id),
                        eq(transcriptions.recordingId, entry.recordingId),
                        eq(transcriptions.userId, scope.userId),
                    ),
                )
                .limit(1);
            if (!transcript) return entry;
            return {
                ...entry,
                inputDigest: portableTrimDigest(transcript),
            };
        }),
    );
}

/** Portable raw transcript identity; source-instance HMACs never enter archives. */
export function portableTrimDigest(transcript: {
    text: string;
    turns: unknown;
}): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                decryptText(transcript.text),
                readTranscriptTurns(transcript),
            ]),
        )
        .digest("hex");
}
