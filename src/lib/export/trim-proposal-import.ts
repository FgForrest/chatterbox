import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { readTrimSnapshot } from "@/db/queries/trim-proposal";
import type { TrimTx } from "@/db/queries/trim-state";
import { itemProcessing, recordings } from "@/db/schema";
import { encryptJsonField } from "@/lib/encryption/fields";
import {
    type ArchivedTrimProposal,
    portableTrimDigest,
} from "@/lib/export/trim-proposal";
import { correctionOverlay, modelInput } from "@/lib/learn/llm-input";
import type { PhaseRecord } from "@/lib/pipeline/types";
import {
    type StoredTrimProposal,
    trimAnchors,
    trimAuditMatches,
    validateTrimOutput,
} from "@/lib/recordings/trim-proposal";
import { preferredTranscript } from "@/lib/transcription/preferred-source";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

/** Rebind a single restored decision, preserving its deadline and restoring no queue state. */
export async function importTrimProposalInTx(
    tx: TrimTx,
    input: {
        archived: ArchivedTrimProposal;
        userId: string;
        recordingIds: ReadonlyMap<string, string>;
        transcriptIds: ReadonlyMap<string, string>;
        profileRevisionIds: ReadonlyMap<string, string>;
        credentialIds?: ReadonlyMap<string, string>;
        payerIds?: ReadonlyMap<string, string>;
        now?: Date;
    },
): Promise<"pending" | "resolved"> {
    const recordingId = input.recordingIds.get(input.archived.recordingId);
    if (!recordingId) throw new Error("Missing restored recording mapping");
    const snapshot = await readTrimSnapshot(tx, input.userId, recordingId);
    if (!snapshot) throw new Error("Restored recording not found");
    const [processing] = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, recordingId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    const now = input.now ?? new Date();
    const source = input.archived.proposal;
    let proposal: StoredTrimProposal | null = null;
    let reason = input.archived.marker?.reason ?? "restored_evaluated";
    if (source) {
        reason =
            Date.parse(source.deadline) <= now.getTime()
                ? "timed_out"
                : "restore_mismatch";
        const transcriptId = input.transcriptIds.get(source.transcript.id);
        const preferred = snapshot.transcripts.find(
            (t) => t.id === transcriptId,
        );
        const profileRevisionId = input.profileRevisionIds.get(
            source.profileRevisionId,
        );
        const revisions = source.revisions.map((r) => ({
            ...r,
            id: input.transcriptIds.get(r.id) ?? "",
        }));
        if (
            source.schemaVersion === 1 &&
            preferred &&
            profileRevisionId &&
            Date.parse(source.deadline) > now.getTime() &&
            trimAuditMatches(snapshot.recording, snapshot.transcripts, {
                audio: source.audio,
                revisions,
            }) &&
            preferred.revision === source.transcript.revision &&
            preferred.source === source.transcript.source
        ) {
            const raw = readTranscriptTurns(preferred);
            if (raw) {
                const rendered = await modelInput(preferred);
                try {
                    if (
                        !source.renderingDigest ||
                        createHash("sha256")
                            .update(JSON.stringify(rendered.turns))
                            .digest("hex") !== source.renderingDigest ||
                        !input.archived.inputDigest ||
                        portableTrimDigest(preferred) !==
                            input.archived.inputDigest
                    )
                        throw new Error("restore_mismatch");
                    const edges = validateTrimOutput(
                        { start: source.start, end: source.end },
                        trimAnchors(
                            raw,
                            await correctionOverlay(preferred, { turns: raw }),
                        ),
                        raw,
                        snapshot.transcripts.map(
                            (t) => readTranscriptTurns(t) ?? [],
                        ),
                        snapshot.recording.duration,
                    );
                    if ((edges.start || edges.end) && rendered.fingerprint)
                        proposal = {
                            ...source,
                            ...edges,
                            id: nanoid(),
                            transcript: {
                                ...source.transcript,
                                id: preferred.id,
                            },
                            revisions,
                            profileRevisionId,
                            inputFingerprint: rendered.fingerprint,
                            provider: {
                                ...source.provider,
                                credentialId:
                                    input.credentialIds?.get(
                                        source.provider.credentialId,
                                    ) ?? "",
                                payerUserId:
                                    input.payerIds?.get(
                                        source.provider.payerUserId,
                                    ) ??
                                    (source.provider.payerUserId ===
                                    input.archived.ownerUserId
                                        ? input.userId
                                        : ""),
                            },
                        };
                } catch {
                    proposal = null;
                }
            }
        }
    }
    const marker = input.archived.marker;
    const restoredInput = preferredTranscript(snapshot.transcripts);
    const phase: PhaseRecord = proposal
        ? {
              proposalId: proposal.id,
              state: "waiting",
              reason: "review_pending",
              waitingFor: { kind: "trimReview", until: proposal.deadline },
              generation: processing?.requestedGeneration ?? 0,
              at: now.toISOString(),
              inputs: {
                  contentId: proposal.transcript.id,
                  contentSourceId: proposal.transcript.source,
                  contentRevision: proposal.transcript.revision,
              },
              profileRevisionId: proposal.profileRevisionId,
          }
        : {
              state: "done",
              reason,
              generation: processing?.requestedGeneration ?? 0,
              at: now.toISOString(),
              ...(restoredInput
                  ? {
                        inputs: {
                            contentId: restoredInput.id,
                            contentSourceId: restoredInput.source,
                            contentRevision: restoredInput.revision,
                        },
                    }
                  : {}),
              ...(marker?.profileRevisionId
                  ? {
                        profileRevisionId: input.profileRevisionIds.get(
                            marker.profileRevisionId,
                        ),
                    }
                  : {}),
          };
    await tx
        .update(recordings)
        .set({ trimProposal: proposal ? encryptJsonField(proposal) : null })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, input.userId),
            ),
        );
    await tx
        .insert(itemProcessing)
        .values({
            itemId: recordingId,
            userId: input.userId,
            view: "private",
            phases: { trim: phase },
        })
        .onConflictDoUpdate({
            target: [itemProcessing.itemId, itemProcessing.view],
            set: {
                phases: { ...processing?.phases, trim: phase },
                updatedAt: now,
            },
        });
    return proposal ? "pending" : "resolved";
}
