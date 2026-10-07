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
import {
    learnReviewItems,
    learnRuns,
    recordings,
    transcriptions,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { wordsAt } from "@/lib/knowledge/correction-anchors";
import {
    type Correction,
    type CorrectionLibrary,
    listCorrections,
    listLibraryCorrections,
} from "@/lib/knowledge/corrections";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import {
    correctedTimeline,
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

/**
 * The corrections on a transcript, as an overlay: the confirmed ones, and
 * (for a model, `pending`) the ticked items of a review not yet finished.
 */
export async function correctionOverlay(
    transcript: {
        id: string;
        userId: string;
        recordingId: string;
        revision: number;
    },
    {
        pending = true,
        turns,
        sharedAs,
        ownerAuthoredOnly = false,
    }: {
        pending?: boolean;
        /**
         * The transcript's turns: a review item groups its occurrences
         * by their words in any case, and each is read at its own words,
         * as finishing the review applies them.
         */
        turns?: readonly TranscriptTurn[] | null;
        /**
         * The sharing state a reader was authorized in. Given, the
         * corrections are read under the recording held for share, and
         * only in that state (404 otherwise): a withdrawal landing
         * meanwhile must not hand the owner's private corrections to
         * whoever read the Organization's.
         */
        sharedAs?: boolean;
        /**
         * On a shared recording, only the confirmed corrections the owner
         * made (`listCorrections`): what an export of the owner's own
         * content carries.
         */
        ownerAuthoredOnly?: boolean;
    } = {},
): Promise<OverlayCorrection[]> {
    const orgUserId = await sharingOrgUserId();
    const { shared, confirmed } =
        sharedAs === undefined
            ? await (async () => {
                  const sharedNow =
                      orgUserId !== null &&
                      (await isRecordingShared(
                          transcript.recordingId,
                          orgUserId,
                      ));
                  return {
                      shared: sharedNow,
                      confirmed: await listCorrections(
                          transcript.userId,
                          transcript.id,
                          db,
                          { shared: sharedNow, ownerAuthoredOnly },
                      ),
                  };
              })()
            : await db.transaction(async (tx) => {
                  await tx
                      .select({ id: recordings.id })
                      .from(recordings)
                      .where(eq(recordings.id, transcript.recordingId))
                      .for("share");
                  const sharedNow =
                      orgUserId !== null &&
                      (await isRecordingShared(
                          transcript.recordingId,
                          orgUserId,
                          tx,
                      ));
                  if (sharedNow !== sharedAs) {
                      throw new AppError(
                          ErrorCode.RECORDING_NOT_FOUND,
                          "Recording not found",
                          404,
                      );
                  }
                  return {
                      shared: sharedNow,
                      confirmed: await listCorrections(
                          transcript.userId,
                          transcript.id,
                          tx,
                          { shared: sharedNow, ownerAuthoredOnly },
                      ),
                  };
              });
    const [run] = !pending
        ? []
        : await db
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
    const ticked = run
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
    if (confirmed.length === 0 && ticked.length === 0) return [];

    // A link shows its target's current name, as the view's readers see it.
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: transcript.userId,
        shared,
    });
    const names = new Map(view.items.map((item) => [item.id, item.name]));
    const overlay = confirmedOverlay(confirmed, names);
    for (const item of ticked) {
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
                heard:
                    wordsAt(
                        turns?.[anchor.turnIndex]?.text,
                        anchor.charStart,
                        anchor.charEnd,
                        payload.heard,
                    ) ?? payload.heard,
                kind: payload.kind,
                replacement:
                    payload.kind === "correct" ? payload.replacement : null,
                meaning,
            });
        }
    }
    return overlay;
}

/** Confirmed corrections as an overlay, each meaning its target's name. */
function confirmedOverlay(
    confirmed: readonly Correction[],
    names: ReadonlyMap<string, string>,
): OverlayCorrection[] {
    const overlay: OverlayCorrection[] = [];
    for (const correction of confirmed) {
        // Carried, so what shows it can undo it.
        const meaning =
            names.get(
                correction.targetPersonId ?? correction.targetEntityId ?? "",
            ) ?? correction.replacement;
        if (meaning === null || meaning === undefined) continue;
        overlay.push({
            id: correction.id,
            turnIndex: correction.turnIndex,
            charStart: correction.charStart,
            charEnd: correction.charEnd,
            heard: correction.heard,
            kind: correction.kind,
            replacement: correction.replacement,
            meaning,
        });
    }
    return overlay;
}

/**
 * The confirmed corrections of every transcript in a library (an owner's
 * live recordings, or the Organization's), as overlays keyed by transcript
 * (`correctionOverlay` with `pending: false`, for all of them at once): an
 * export of everything, or the recording list, reads them in one query,
 * and each view's names once.
 */
export async function confirmedOverlays(
    library: CorrectionLibrary,
): Promise<Map<string, OverlayCorrection[]>> {
    const corrections = await listLibraryCorrections(library);
    const orgUserId = await sharingOrgUserId();
    const ownerUserId =
        "ownerUserId" in library ? library.ownerUserId : (orgUserId ?? "");
    const namesOf = new Map<boolean, Promise<Map<string, string>>>();
    const names = (shared: boolean) => {
        let held = namesOf.get(shared);
        if (!held) {
            held = knowledgeView({
                kind: "recording",
                ownerUserId,
                shared,
            }).then(
                (view) =>
                    new Map(view.items.map((item) => [item.id, item.name])),
            );
            namesOf.set(shared, held);
        }
        return held;
    };
    const overlays = new Map<string, OverlayCorrection[]>();
    for (const [transcriptionId, held] of corrections) {
        overlays.set(
            transcriptionId,
            confirmedOverlay(held.corrections, await names(held.shared)),
        );
    }
    return overlays;
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
        await correctionOverlay(transcript, { turns: stored }),
    );
    return {
        turns,
        text: flattenTurns(turns),
        fingerprint: llmInputFingerprint(turns),
    };
}

/**
 * What a model is given of a transcript (summaries, topics, titles): the
 * stored text as it is while no correction changes it, so a transcript
 * without corrections reads exactly as before; the corrected rendering
 * once one does. With the fingerprint of the corrected turns, null for a
 * transcript without turns (nothing can correct it).
 */
export async function modelInput(transcript: {
    id: string;
    userId: string;
    recordingId: string;
    revision: number;
    text: string;
    turns: unknown;
}): Promise<{
    text: string;
    turns: TranscriptTurn[] | null;
    fingerprint: string | null;
    /** Where a place in a corrected turn was as heard (`correctedTimeline`). */
    toHeard?: (turnIndex: number, fraction: number) => number;
}> {
    const stored = decryptText(transcript.text) ?? "";
    const turns = readTranscriptTurns(transcript);
    if (!turns?.length) return { text: stored, turns: null, fingerprint: null };
    const overlay = await correctionOverlay(transcript, { turns });
    const rendered = renderTurnsForLlm(turns, overlay);
    const corrected = rendered.some(
        (turn, index) => turn.text !== turns[index]?.text,
    );
    return {
        text: corrected ? flattenTurns(rendered) : stored,
        turns: rendered,
        fingerprint: llmInputFingerprint(rendered),
        toHeard: correctedTimeline(turns, overlay),
    };
}
