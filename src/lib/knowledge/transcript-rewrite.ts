/**
 * The one hook every writer of transcript text or turns calls, in the
 * transaction that writes them and under the recording lock, right after
 * the write: what was said about the old text is carried onto the new one,
 * or dropped.
 *
 * - speaker rows and rejections, by speech overlap
 *   (`remapTranscriptAttributionsInTx`);
 * - corrections, by their words (`recheckCorrectionsInTx`);
 * - fact evidence, by the words at its time and the voice it depends on
 *   (`recheckEvidenceInTx`).
 *
 * Pending Learn runs join it with them.
 */

import type { db } from "@/db";
import { remapTranscriptAttributionsInTx } from "@/lib/knowledge/attribution";
import { recheckCorrectionsInTx } from "@/lib/knowledge/correction-recheck";
import { recheckEvidenceInTx } from "@/lib/knowledge/fact-evidence";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import type { SpeakerVersion } from "@/lib/knowledge/speaker-label-rules";

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
    await remapTranscriptAttributionsInTx(tx, args);
    const corrected = await recheckCorrectionsInTx(tx, {
        transcriptionId: args.transcriptionId,
        previousTurns: args.previous.turns,
        nextTurns: args.next.turns,
    });
    const evidenced = await recheckEvidenceInTx(tx, {
        transcriptionId: args.transcriptionId,
        previous: args.previous,
        next: args.next,
    });
    // Once, after both: the knowledge of every scope the rewrite touched.
    await bumpScopeInTx(tx, [...corrected, ...evidenced]);
}
