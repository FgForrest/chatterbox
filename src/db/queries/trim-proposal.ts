import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    lockTrimRecording,
    resolveTrimInTx,
    type TrimTx,
} from "@/db/queries/trim-state";

export {
    lockTrimRecording,
    resolveTrimInTx,
    type TrimTx,
} from "@/db/queries/trim-state";

import { transcriptions } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import { modelInput } from "@/lib/learn/llm-input";
import {
    type StoredTrimProposal,
    trimAnchors,
    validateTrimOutput,
} from "@/lib/recordings/trim-proposal";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

/** Read all inputs under the recording writer lock, including secondary transcripts. */
export async function readTrimSnapshot(
    tx: TrimTx,
    userId: string,
    recordingId: string,
) {
    const recording = await lockTrimRecording(tx, userId, recordingId);
    if (!recording) return null;
    const transcripts = await tx
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        )
        .orderBy(transcriptions.id);
    return { recording, transcripts };
}

/** Recheck the complete reviewed snapshot before accepting or publishing a proposal. */
export async function trimSnapshotMatches(
    snapshot: NonNullable<Awaited<ReturnType<typeof readTrimSnapshot>>>,
    proposal: StoredTrimProposal,
): Promise<boolean> {
    const { recording, transcripts } = snapshot;
    if (
        recording.fileMd5 !== proposal.audio.fileMd5 ||
        recording.duration !== proposal.audio.duration ||
        (recording.cutAt?.toISOString() ?? null) !== proposal.audio.cutAt ||
        transcripts.length !== proposal.revisions.length ||
        transcripts.some(
            (t) =>
                !proposal.revisions.some(
                    (r) => r.id === t.id && r.revision === t.revision,
                ),
        )
    )
        return false;
    const preferred = transcripts.find(
        (t) =>
            t.id === proposal.transcript.id &&
            t.source === proposal.transcript.source &&
            t.revision === proposal.transcript.revision,
    );
    if (!preferred) return false;
    const input = await modelInput(preferred);
    if (input.fingerprint !== proposal.inputFingerprint) return false;
    const raw = readTranscriptTurns(preferred);
    if (!raw) return false;
    try {
        // Stored IDs were built from raw anchors, including correction-spanning groups.
        const anchors = trimAnchors(raw);
        validateTrimOutput(
            { start: proposal.start, end: proposal.end },
            anchors,
            raw,
            transcripts.map((t) => readTranscriptTurns(t) ?? []),
            recording.duration,
        );
        return true;
    } catch {
        return false;
    }
}

/** Read only the owner's current, valid decision; shared views never call this. */
export async function readOwnerTrimProposal(
    userId: string,
    recordingId: string,
): Promise<StoredTrimProposal | null> {
    return db.transaction(async (tx) => {
        const snapshot = await readTrimSnapshot(tx, userId, recordingId);
        if (!snapshot) return null;
        const proposal = decryptJsonField<StoredTrimProposal>(
            snapshot.recording.trimProposal,
        );
        if (!proposal) return null;
        if (!(await trimSnapshotMatches(snapshot, proposal))) {
            await resolveTrimInTx(tx, {
                userId,
                recordingId,
                reason: "content_changed",
            });
            return null;
        }
        if (Date.parse(proposal.deadline) <= Date.now()) {
            await resolveTrimInTx(tx, {
                userId,
                recordingId,
                reason: "timed_out",
            });
            return null;
        }
        return proposal;
    });
}
