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
 * Which audio a transcript written now is made from. `audioMd5` is the md5
 * its maker read when it began (undefined: the recording's current one;
 * null: not known, as for a browser's). The writer holds the recording's
 * lock, so `current` is what a sync committed: when it differs, the audio
 * was replaced while the transcript was being made, and the text may come
 * from either. It keeps the md5 it began on, which differs from the
 * recording's, so every later change of audio or transcript still counts
 * as one; and it is `moved` now, its names no longer certain.
 */
function madeFrom(
    audioMd5: string | null | undefined,
    current: string | null,
): { md5: string | null; moved: boolean } {
    if (audioMd5 === undefined) return { md5: current, moved: false };
    return {
        md5: audioMd5,
        moved: Boolean(audioMd5 && current && audioMd5 !== current),
    };
}

/**
 * Record on a transcript the audio it is made from now (see `madeFrom`), in
 * the transaction that writes it, under the recording's lock. Returns
 * whether that audio differs from what it was made from before, or may:
 * replaced while it was being made (a change whatever was known before).
 * Otherwise unknown before (older transcripts, no md5) is not a change.
 */
export async function stampTranscriptAudioInTx(
    tx: Tx,
    transcriptionId: string,
    audioMd5?: string | null,
): Promise<boolean> {
    const [row] = await tx
        .select({
            before: transcriptions.audioMd5,
            current: recordings.fileMd5,
        })
        .from(transcriptions)
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .where(eq(transcriptions.id, transcriptionId))
        .limit(1);
    if (!row) return false;
    const now = madeFrom(audioMd5, row.current);
    if (row.before !== now.md5) {
        await tx
            .update(transcriptions)
            .set({ audioMd5: now.md5 })
            .where(eq(transcriptions.id, transcriptionId));
    }
    if (now.moved) return true;
    return Boolean(row.before && now.md5 && row.before !== now.md5);
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
        /** The md5 of the audio it was made from (see `madeFrom`). */
        audioMd5?: string | null;
    },
): Promise<void> {
    await tx
        .update(transcriptions)
        .set({
            // `madeFrom`'s md5, in the one statement.
            audioMd5:
                audioMd5 === undefined
                    ? sql`(select ${recordings.fileMd5} from ${recordings} where ${recordings.id} = ${recordingId})`
                    : audioMd5,
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
 * Only when this sync changed the audio (`from` → `to`): a later sync of
 * Plaud's metadata alone (a rename, the trash) brings the same audio again
 * and must not demote the names a person confirmed since. Unknown audio on
 * either side is no change. In the transaction that writes the new audio,
 * under the recording lock.
 */
export async function audioReplacedInTx(
    tx: Tx,
    recordingId: string,
    audio: { from: string | null; to: string | null },
): Promise<void> {
    const audioMd5 = audio.to;
    if (!audio.from || !audioMd5 || audio.from === audioMd5) return;
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
        // Unknown audio (a browser's) was made before this sync: from the
        // audio being replaced, or an older one.
        if (row.audioMd5 === audioMd5) continue;
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
