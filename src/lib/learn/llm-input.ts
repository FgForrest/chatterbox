/**
 * What a model reads of a transcript (Task 5.1): its turns with the
 * corrections that hold for everyone reading it in its current view, and a
 * fingerprint of that text, so a summary or topics made from an older
 * rendering can be told apart.
 *
 * The corrections: the confirmed ones (`listCorrections`: the
 * Organization's while the recording is shared, the owner's otherwise),
 * and the ticked items of a review in that view not yet finished, which is
 * the "yes unless you say no" default. Never an unticked one.
 */

import { createHmac, hkdfSync } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { learnReviewItems, learnRuns, transcriptions } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { listCorrections } from "@/lib/knowledge/corrections";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import {
    flattenTurns,
    type OverlayCorrection,
    renderTurnsForLlm,
} from "@/lib/learn/render";
import { isRecordingShared } from "@/lib/sharing/shared";
import { sharingOrgUserId } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const FINGERPRINT_DOMAIN = "riffado:llm-input";

let derived: { secret: string; key: Buffer } | null = null;

function fingerprintKey(): Buffer {
    const secret = env.API_TOKEN_HASH_SECRET ?? env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("The server secret is not configured");
    if (derived?.secret !== secret) {
        derived = {
            secret,
            key: Buffer.from(
                hkdfSync("sha256", secret, "", FINGERPRINT_DOMAIN, 32),
            ),
        };
    }
    return derived.key;
}

/**
 * A keyed HMAC of what a model reads: equal exactly when the text is, and
 * telling nothing of it.
 */
export function llmInputFingerprint(turns: readonly TranscriptTurn[]): string {
    return createHmac("sha256", fingerprintKey())
        .update(flattenTurns(turns))
        .digest("hex");
}

type ItemPayload = {
    kind: "correct" | "link";
    heard: string;
    target: { personId: string } | { entityId: string };
    replacement: string | null;
    anchors: { turnIndex: number; charStart: number; charEnd: number }[];
};

/** The corrections a model reads on a transcript, as an overlay. */
export async function correctionOverlay(transcript: {
    id: string;
    userId: string;
    recordingId: string;
    revision: number;
}): Promise<OverlayCorrection[]> {
    const orgUserId = await sharingOrgUserId();
    const shared =
        orgUserId !== null &&
        (await isRecordingShared(transcript.recordingId, orgUserId));
    const confirmed = await listCorrections(transcript.userId, transcript.id);
    const [run] = await db
        .select({ id: learnRuns.id })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.transcriptionId, transcript.id),
                eq(learnRuns.view, shared ? "org" : "private"),
                eq(learnRuns.status, "ready"),
                eq(learnRuns.transcriptRevision, transcript.revision),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    const pending = run
        ? (
              await db
                  .select()
                  .from(learnReviewItems)
                  .where(
                      and(
                          eq(learnReviewItems.runId, run.id),
                          eq(learnReviewItems.kind, "correction"),
                      ),
                  )
          ).filter(
              (item) =>
                  (item.decision ??
                      (item.preTicked ? "accepted" : "rejected")) ===
                  "accepted",
          )
        : [];
    if (confirmed.length === 0 && pending.length === 0) return [];

    // A link shows its target's current name, as the view's readers see it.
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: transcript.userId,
        shared,
    });
    const names = new Map(view.items.map((item) => [item.id, item.name]));
    const overlay: OverlayCorrection[] = [];
    for (const correction of confirmed) {
        const meaning =
            names.get(
                correction.targetPersonId ?? correction.targetEntityId ?? "",
            ) ?? correction.replacement;
        if (meaning === null || meaning === undefined) continue;
        overlay.push({
            turnIndex: correction.turnIndex,
            charStart: correction.charStart,
            charEnd: correction.charEnd,
            heard: correction.heard,
            kind: correction.kind,
            replacement: correction.replacement,
            meaning,
        });
    }
    for (const item of pending) {
        const payload = decryptJsonField<ItemPayload>(item.payload);
        if (!payload) continue;
        const targetId =
            "personId" in payload.target
                ? payload.target.personId
                : payload.target.entityId;
        // A target the view no longer reads is no correction for it.
        const meaning = names.get(targetId);
        if (meaning === undefined) continue;
        for (const anchor of payload.anchors) {
            overlay.push({
                ...anchor,
                heard: payload.heard,
                kind: payload.kind,
                replacement:
                    payload.kind === "correct" ? payload.replacement : null,
                meaning,
            });
        }
    }
    return overlay;
}

/**
 * A transcript as a model reads it: its turns corrected, as one text, and
 * the fingerprint of that text. Null for a transcript without turns.
 */
export async function llmRendering(transcriptionId: string): Promise<{
    turns: TranscriptTurn[];
    text: string;
    fingerprint: string;
} | null> {
    const [transcript] = await db
        .select()
        .from(transcriptions)
        .where(eq(transcriptions.id, transcriptionId))
        .limit(1);
    if (!transcript) return null;
    const stored = readTranscriptTurns(transcript);
    if (!stored?.length) return null;
    const turns = renderTurnsForLlm(
        stored,
        await correctionOverlay(transcript),
    );
    return {
        turns,
        text: flattenTurns(turns),
        fingerprint: llmInputFingerprint(turns),
    };
}
