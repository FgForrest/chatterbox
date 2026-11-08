import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    lockTrimRecording,
    resolveTrimInTx,
    type TrimTx,
} from "@/db/queries/trim-state";
import { recordings, transcriptions } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import { modelInput } from "@/lib/learn/llm-input";
import {
    type StoredTrimProposal,
    trimAnchors,
    validateTrimOutput,
} from "@/lib/recordings/trim-proposal";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

export {
    lockTrimRecording,
    resolveTrimInTx,
    type TrimTx,
} from "@/db/queries/trim-state";

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
        const read = async () => {
            const [recording] = await tx
                .select({
                    trimProposal: recordings.trimProposal,
                    fileMd5: recordings.fileMd5,
                    duration: recordings.duration,
                    cutAt: recordings.cutAt,
                })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                        isNull(recordings.deletedAt),
                    ),
                )
                .limit(1);
            const proposal = decryptJsonField<StoredTrimProposal>(
                recording?.trimProposal,
            );
            if (!recording || !proposal) return { proposal: null };
            const revisions = await tx
                .select({
                    id: transcriptions.id,
                    revision: transcriptions.revision,
                })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                    ),
                );
            const changed =
                recording.fileMd5 !== proposal.audio.fileMd5 ||
                recording.duration !== proposal.audio.duration ||
                (recording.cutAt?.toISOString() ?? null) !==
                    proposal.audio.cutAt ||
                revisions.length !== proposal.revisions.length ||
                revisions.some(
                    (revision) =>
                        !proposal.revisions.some(
                            (expected) =>
                                expected.id === revision.id &&
                                expected.revision === revision.revision,
                        ),
                );
            const reason = changed
                ? "content_changed"
                : Date.parse(proposal.deadline) <= Date.now()
                  ? "timed_out"
                  : undefined;
            return { proposal, reason };
        };
        const current = await read();
        if (!current.proposal || !current.reason) return current.proposal;
        if (!(await lockTrimRecording(tx, userId, recordingId))) return null;
        const locked = await read();
        if (!locked.proposal || !locked.reason) return locked.proposal;
        await resolveTrimInTx(tx, {
            userId,
            recordingId,
            reason: locked.reason,
        });
        return null;
    });
}
