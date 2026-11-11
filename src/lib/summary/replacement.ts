import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, itemProcessing, mailContents } from "@/db/schema";
import { itemProfileFenceMatches } from "@/lib/pipeline/effective-profile";
import type {
    ContentRevisionInput,
    PipelinePhases,
} from "@/lib/pipeline/types";
import { readPreferredTranscriptInput } from "@/lib/transcription/read-source";

type SavedSummary = Pick<
    typeof aiEnhancements.$inferSelect,
    "id" | "revision" | "editedAt" | "inputs" | "transcriptionId" | "source"
>;
type Processing = { profileRevisionId: string | null; phases: PipelinePhases };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A durable arrival may still need its first custom Summary step despite imported output. */
export function initialCustomSummaryPending(
    summary: SavedSummary | undefined,
    processing: Processing | undefined,
): boolean {
    const phase = processing?.phases.summary;
    return (
        summary?.source === "plaud" &&
        !summary.editedAt &&
        processing?.phases.categorize?.arrivalGeneration !== undefined &&
        phase?.steps?.summary?.state !== "done" &&
        !(phase?.state === "done" && phase.steps === undefined)
    );
}

/** Require changed base input or an unfulfilled explicit request to replace saved output. */
export function automaticSummaryReplacementAllowed(
    summary: SavedSummary | undefined,
    content: ContentRevisionInput | null,
    processing: Processing | undefined,
): boolean {
    if (!summary) return true;
    if (summary.editedAt) return false;
    if (initialCustomSummaryPending(summary, processing)) return true;
    const refresh = processing?.phases.categorize?.summaryRefresh;
    if (refresh?.id === summary.id && refresh.revision === summary.revision)
        return true;
    const inputs = summary.inputs;
    if (
        content &&
        inputs &&
        typeof inputs.contentId === "string" &&
        typeof inputs.contentSourceId === "string" &&
        (typeof inputs.contentRevision === "number" ||
            typeof inputs.contentRevision === "string") &&
        (inputs.contentId !== content.contentId ||
            inputs.contentSourceId !== content.contentSourceId ||
            inputs.contentRevision !== content.contentRevision)
    )
        return true;
    if (
        content &&
        summary.transcriptionId &&
        summary.transcriptionId !== content.contentId
    )
        return true;
    return Boolean(
        inputs &&
            (typeof inputs.itemProfileRevisionId === "string" ||
                inputs.itemProfileRevisionId === null) &&
            !itemProfileFenceMatches(inputs.itemProfileRevisionId, processing),
    );
}

/** Read the replacement decision; writers pass their item-locked transaction. */
export async function mayAutomaticallyReplaceSummary(
    userId: string,
    itemId: string,
    tx?: Tx,
): Promise<boolean> {
    const executor = tx ?? db;
    const query = executor
        .select({
            profileRevisionId: itemProcessing.profileRevisionId,
            phases: itemProcessing.phases,
        })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .limit(1);
    const [processing] = await (tx ? query.for("update") : query);
    const [summary] = await executor
        .select({
            id: aiEnhancements.id,
            source: aiEnhancements.source,
            revision: aiEnhancements.revision,
            inputs: aiEnhancements.inputs,
            transcriptionId: aiEnhancements.transcriptionId,
            editedAt: aiEnhancements.editedAt,
        })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, itemId),
                eq(aiEnhancements.userId, userId),
                isNotNull(aiEnhancements.summary),
            ),
        )
        .orderBy(desc(aiEnhancements.source))
        .limit(1);
    if (!summary) return true;
    const transcript = await readPreferredTranscriptInput(
        itemId,
        userId,
        executor,
    );
    const [mail] = transcript
        ? []
        : await executor
              .select({ id: mailContents.id, revision: mailContents.revision })
              .from(mailContents)
              .where(
                  and(
                      eq(mailContents.itemId, itemId),
                      eq(mailContents.userId, userId),
                  ),
              )
              .limit(1);
    const content = transcript
        ? transcript
        : mail
          ? {
                contentId: mail.id,
                contentSourceId: "mail",
                contentRevision: mail.revision,
            }
          : null;
    return automaticSummaryReplacementAllowed(summary, content, processing);
}

/** Authorize one replacement after an explicit request or a real correction input write. */
export async function authorizeSummaryReplacementInTx(
    tx: Tx,
    input: { itemId: string; userId: string; generation: number },
): Promise<void> {
    const [current] = await tx
        .select({ phases: itemProcessing.phases })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .for("update")
        .limit(1);
    if (!current) return;
    const [summary] = await tx
        .select({ id: aiEnhancements.id, revision: aiEnhancements.revision })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, input.itemId),
                eq(aiEnhancements.userId, input.userId),
                isNotNull(aiEnhancements.summary),
            ),
        )
        .orderBy(desc(aiEnhancements.source))
        .limit(1);
    await tx
        .update(itemProcessing)
        .set({
            phases: {
                ...current.phases,
                categorize: {
                    ...(current.phases.categorize ?? {
                        state: "done" as const,
                        reason: "legacy",
                        generation: input.generation,
                        at: new Date().toISOString(),
                    }),
                    summaryRefresh: {
                        id: summary?.id ?? null,
                        revision: summary?.revision ?? null,
                        generation: input.generation,
                    },
                },
            },
        })
        .where(
            and(
                eq(itemProcessing.itemId, input.itemId),
                eq(itemProcessing.userId, input.userId),
                eq(itemProcessing.view, "private"),
            ),
        );
}
