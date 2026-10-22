import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { learnReviewItems, learnRuns } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import type { TranscriptSpeaker } from "@/lib/knowledge/attribution";
import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import type { SpeakerProposalContext } from "./output";

/** Adds a matching Learn proposal's provenance only to visible suggested rows. */
export async function withSpeakerProposalContext(
    ownerUserId: string,
    scopeUserId: string,
    transcriptionId: string,
    revision: number,
    rows: TranscriptSpeaker[],
): Promise<
    (TranscriptSpeaker & {
        proposal?: SpeakerProposalContext & { reason: string };
    })[]
> {
    const fromLearn = (row: TranscriptSpeaker) =>
        row.status === "suggested" &&
        (row.source === "llm" ||
            row.source === "calendar" ||
            row.source === "meet");
    if (!rows.some(fromLearn)) return rows;
    const proposals = await db
        .select({ payload: learnReviewItems.payload })
        .from(learnReviewItems)
        .innerJoin(learnRuns, eq(learnRuns.id, learnReviewItems.runId))
        .where(
            and(
                eq(learnRuns.userId, ownerUserId),
                eq(learnRuns.scopeUserId, scopeUserId),
                eq(learnRuns.transcriptionId, transcriptionId),
                eq(learnRuns.transcriptRevision, revision),
                eq(learnReviewItems.userId, scopeUserId),
                eq(learnReviewItems.kind, "speaker"),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(128);
    const contexts = proposals.map(({ payload }) =>
        decryptJsonField<
            SpeakerProposalContext & {
                label: string;
                personId: string | null;
                reason: string;
            }
        >(payload),
    );
    return rows.map((row) => {
        const proposal = fromLearn(row)
            ? contexts.find(
                  (context) =>
                      context &&
                      speakerKey(context.label) === speakerKey(row.label) &&
                      context.personId === row.personId,
              )
            : undefined;
        return proposal
            ? {
                  ...row,
                  proposal: {
                      source: proposal.source,
                      guess: proposal.guess,
                      reason: proposal.reason,
                  },
              }
            : row;
    });
}

/** Finds roster provenance for a new name confirmed directly from the transcript strip. */
export async function rosterProposalSourceForName(
    executor: Pick<typeof db, "select">,
    input: {
        ownerUserId: string;
        scopeUserId: string;
        transcriptionId: string;
        revision: number;
        label: string;
        displayName: string;
    },
): Promise<"calendar" | "meet" | undefined> {
    const rows = await executor
        .select({
            runId: learnRuns.id,
            kind: learnReviewItems.kind,
            payload: learnReviewItems.payload,
            choice: learnReviewItems.choice,
        })
        .from(learnReviewItems)
        .innerJoin(learnRuns, eq(learnRuns.id, learnReviewItems.runId))
        .where(
            and(
                eq(learnRuns.userId, input.ownerUserId),
                eq(learnRuns.status, "ready"),
                inArray(learnReviewItems.kind, ["speaker", "new_record"]),
                eq(learnRuns.scopeUserId, input.scopeUserId),
                eq(learnRuns.transcriptionId, input.transcriptionId),
                eq(learnRuns.transcriptRevision, input.revision),
                eq(learnReviewItems.userId, input.scopeUserId),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(128);
    const proposals = rows.map((row) => ({
        ...row,
        choice: row.choice
            ? decryptJsonField<{ name?: string }>(row.choice)
            : null,
        payload: decryptJsonField<
            SpeakerProposalContext & {
                label?: string;
                personId?: string | null;
                newRef?: string;
                ref?: string;
                name?: string;
            }
        >(row.payload),
    }));
    for (const row of proposals) {
        const proposal = row.payload;
        if (
            row.kind !== "speaker" ||
            !proposal?.guess ||
            proposal.personId ||
            !proposal.newRef ||
            speakerKey(proposal.label ?? "") !== speakerKey(input.label)
        )
            continue;
        const record = proposals.find(
            (other) =>
                other.runId === row.runId &&
                other.kind === "new_record" &&
                other.payload?.ref === proposal.newRef,
        );
        if (
            (record?.choice?.name ?? record?.payload?.name) ===
                input.displayName &&
            (proposal.source === "calendar" || proposal.source === "meet")
        )
            return proposal.source;
    }
    return undefined;
}
