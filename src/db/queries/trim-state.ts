import { and, eq, isNull } from "drizzle-orm";
import type { db } from "@/db";
import { readActiveCutJob } from "@/db/queries/active-cut-job";
import { wakePipelineInTx } from "@/db/queries/pipeline-jobs";
import { wakeTrimDownstreamInTx } from "@/db/queries/trim-downstream";
import { itemProcessing, recordings } from "@/db/schema";
import type { ContentRevisionInput } from "@/lib/pipeline/types";
import { trimHolds } from "@/lib/recordings/trim-proposal";

export type TrimTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Acquire the owner recording before processing/job locks, as all trim writers do. */
export async function lockTrimRecording(
    tx: TrimTx,
    userId: string,
    recordingId: string,
) {
    const [recording] = await tx
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .for("update")
        .limit(1);
    return recording;
}

/** Resolve a private decision once, under recording → processing locks, and wake planning. */
export async function resolveTrimInTx(
    tx: TrimTx,
    input: {
        userId: string;
        recordingId: string;
        reason: string;
        proposalId?: string;
        now?: Date;
        content?: ContentRevisionInput;
        force?: boolean;
    },
): Promise<boolean> {
    const recording = await lockTrimRecording(
        tx,
        input.userId,
        input.recordingId,
    );
    if (!recording) return false;
    const [processing] = await tx
        .select()
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.recordingId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    const phase = processing?.phases.trim;
    if (!phase && !recording.trimProposal) return false;
    if (
        input.proposalId &&
        (!recording.trimProposal ||
            phase?.proposalId !== input.proposalId ||
            !trimHolds(phase))
    )
        return false;
    if (!processing || (!trimHolds(phase) && !input.force)) return false;
    const now = input.now ?? new Date();
    if (
        input.reason === "timed_out" &&
        (!phase?.waitingFor?.until ||
            Date.parse(phase.waitingFor.until) > now.getTime())
    )
        return false;
    if (
        input.proposalId &&
        phase?.waitingFor?.until &&
        Date.parse(phase.waitingFor.until) <= now.getTime()
    )
        return false;
    const cut = await readActiveCutJob(tx, input.userId, input.recordingId);
    if (cut && !input.force) return false;
    await tx
        .update(recordings)
        .set({ trimProposal: null })
        .where(
            and(
                eq(recordings.id, input.recordingId),
                eq(recordings.userId, input.userId),
            ),
        );
    await tx
        .update(itemProcessing)
        .set({
            phases: {
                ...processing.phases,
                trim: {
                    state: "done",
                    reason: input.reason,
                    inputs: input.content ?? phase?.inputs,
                    profileRevisionId: phase?.profileRevisionId,
                    generation: processing.requestedGeneration,
                    at: now.toISOString(),
                },
            },
            updatedAt: now,
        })
        .where(
            and(
                eq(itemProcessing.itemId, input.recordingId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        );
    await wakePipelineInTx(tx, input.recordingId, input.userId);
    await wakeTrimDownstreamInTx(tx, input.userId, input.recordingId);
    return true;
}
