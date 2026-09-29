/**
 * The one hook every writer of transcript text or turns calls, in the
 * transaction that writes them and under the recording lock, right after
 * the write: what was said about the old text is carried onto the new one,
 * or dropped.
 *
 * - speaker rows and rejections, by speech overlap
 *   (`remapTranscriptAttributionsInTx`), as suggestions only when the
 *   audio under the transcript changed (`audioMd5`: the timeline shifted);
 * - corrections, by their words (`recheckCorrectionsInTx`);
 * - fact evidence, by the words at its time and the voice it depends on
 *   (`recheckEvidenceInTx`).
 *
 * - Learn runs not yet finished read the old text: superseded, so their
 *   review cannot be finished and offers a rerun; and a hold automatic
 *   Learn kept on the recording's title, summary and topics for the old
 *   Riffado transcript goes: the new one's transcription decides.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "@/db";
import { learnRuns, recordings, transcriptions } from "@/db/schema";
import { remapTranscriptAttributionsInTx } from "@/lib/knowledge/attribution";
import { recheckCorrectionsInTx } from "@/lib/knowledge/correction-recheck";
import { recheckEvidenceInTx } from "@/lib/knowledge/fact-evidence";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import type { SpeakerVersion } from "@/lib/knowledge/speaker-label-rules";
import {
    clearAutoLearnHoldInTx,
    riffadoRecordingOfInTx,
} from "@/lib/learn/hold";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function transcriptRewrittenInTx(
    tx: Tx,
    args: {
        userId: string;
        transcriptionId: string;
        previous: SpeakerVersion;
        next: SpeakerVersion;
    },
): Promise<void> {
    const audioChanged = await stampTranscriptAudioInTx(
        tx,
        args.transcriptionId,
    );
    await remapTranscriptAttributionsInTx(tx, { ...args, audioChanged });
    const corrected = await recheckCorrectionsInTx(tx, {
        transcriptionId: args.transcriptionId,
        previousTurns: args.previous.turns,
        nextTurns: args.next.turns,
    });
    const evidenced = await recheckEvidenceInTx(tx, {
        transcriptionId: args.transcriptionId,
        previous: args.previous,
        next: args.next,
        audioChanged,
    });
    await tx
        .update(learnRuns)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(
            and(
                eq(learnRuns.transcriptionId, args.transcriptionId),
                inArray(learnRuns.status, ["queued", "running", "ready"]),
            ),
        );
    const held = await riffadoRecordingOfInTx(tx, args.transcriptionId);
    if (held) await clearAutoLearnHoldInTx(tx, held);
    // Once, after both: the knowledge of every scope the rewrite touched.
    await bumpScopeInTx(tx, [...corrected, ...evidenced]);
}

/**
 * Record on a transcript the audio it is made from now (the recording's
 * `fileMd5`), in the transaction that writes it. Returns whether that audio
 * differs from what it was made from before; unknown before (older
 * transcripts, no md5) is not a change.
 */
export async function stampTranscriptAudioInTx(
    tx: Tx,
    transcriptionId: string,
): Promise<boolean> {
    const [row] = await tx
        .select({
            before: transcriptions.audioMd5,
            now: recordings.fileMd5,
        })
        .from(transcriptions)
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .where(eq(transcriptions.id, transcriptionId))
        .limit(1);
    if (!row) return false;
    if (row.before !== row.now) {
        await tx
            .update(transcriptions)
            .set({ audioMd5: row.now })
            .where(eq(transcriptions.id, transcriptionId));
    }
    return Boolean(row.before && row.now && row.before !== row.now);
}

/** `stampTranscriptAudioInTx` for a transcript just inserted. */
export async function stampNewTranscriptAudioInTx(
    tx: Tx,
    {
        recordingId,
        userId,
        source,
    }: { recordingId: string; userId: string; source: string },
): Promise<void> {
    await tx
        .update(transcriptions)
        .set({
            audioMd5: sql`(select ${recordings.fileMd5} from ${recordings} where ${recordings.id} = ${recordingId})`,
        })
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
            ),
        );
}
