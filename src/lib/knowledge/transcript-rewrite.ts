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
 * - Learn runs not yet finished read the old text: superseded, so their
 *   review cannot be finished and offers a rerun; and a hold automatic
 *   Learn kept on the recording's title, summary and topics for the old
 *   Riffado transcript goes: the new one's transcription decides.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { learnRuns } from "@/db/schema";
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
