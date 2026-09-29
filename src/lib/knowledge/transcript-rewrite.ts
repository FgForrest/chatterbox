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
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
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
        /**
         * The md5 of the audio the new text was made from, read when its
         * transcription began; the recording's current one by default.
         */
        audioMd5?: string | null;
    },
): Promise<void> {
    const audioChanged = await stampTranscriptAudioInTx(
        tx,
        args.transcriptionId,
        args.audioMd5,
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
    audioMd5?: string | null,
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
    const now = audioMd5 ?? row.now;
    if (row.before !== now) {
        await tx
            .update(transcriptions)
            .set({ audioMd5: now })
            .where(eq(transcriptions.id, transcriptionId));
    }
    return Boolean(row.before && now && row.before !== now);
}

/** `stampTranscriptAudioInTx` for a transcript just inserted. */
export async function stampNewTranscriptAudioInTx(
    tx: Tx,
    {
        recordingId,
        userId,
        source,
        audioMd5,
    }: {
        recordingId: string;
        userId: string;
        source: string;
        /** The md5 of the audio it was made from; the recording's by default. */
        audioMd5?: string | null;
    },
): Promise<void> {
    await tx
        .update(transcriptions)
        .set({
            audioMd5:
                audioMd5 ??
                sql`(select ${recordings.fileMd5} from ${recordings} where ${recordings.id} = ${recordingId})`,
        })
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
            ),
        );
}

/**
 * A sync replaced a recording's audio (a Plaud recording trimmed in the app
 * and synced again) and kept the transcripts made from the old audio: their
 * timeline no longer matches it, so no name on them is the same voice for
 * certain any more. Every speaker pair becomes a suggestion at best and
 * evidence tied to a speaker is marked for review, as a rewrite over other
 * audio does; the transcripts keep the md5 of the audio they were made from.
 * In the transaction that writes the new audio, under the recording lock.
 */
export async function audioReplacedInTx(
    tx: Tx,
    recordingId: string,
    audioMd5: string | null,
): Promise<void> {
    if (!audioMd5) return;
    const rows = await tx
        .select({
            id: transcriptions.id,
            userId: transcriptions.userId,
            text: transcriptions.text,
            turns: transcriptions.turns,
            source: transcriptions.source,
            model: transcriptions.model,
            audioMd5: transcriptions.audioMd5,
        })
        .from(transcriptions)
        .where(eq(transcriptions.recordingId, recordingId))
        .orderBy(transcriptions.id)
        .for("update");
    const scopes: string[] = [];
    for (const row of rows) {
        if (!row.audioMd5 || row.audioMd5 === audioMd5) continue;
        const version = storedSpeakerVersion(row);
        await remapTranscriptAttributionsInTx(tx, {
            userId: row.userId,
            transcriptionId: row.id,
            previous: version,
            next: version,
            audioChanged: true,
        });
        const evidenced = await recheckEvidenceInTx(tx, {
            transcriptionId: row.id,
            previous: version,
            next: version,
            audioChanged: true,
        });
        scopes.push(...evidenced);
    }
    if (scopes.length > 0) await bumpScopeInTx(tx, scopes);
}
