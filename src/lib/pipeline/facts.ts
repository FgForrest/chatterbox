import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    chatterItems,
    mailContents,
    mailMessages,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { pickEnhancementCredential } from "@/lib/ai/enhancement-provider";
import { isSummaryStale } from "@/lib/learn/summary-refresh";
import { readProcessing } from "@/lib/pipeline/state";
import type { PipelineFacts, PipelineView } from "@/lib/pipeline/types";
import { recordingJobSubject } from "@/lib/sharing/view";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";

async function readShared(itemId: string, userId: string): Promise<boolean> {
    const [row] = await db
        .select({ itemId: recordingFolderAssignments.itemId })
        .from(recordingFolderAssignments)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingFolderAssignments.itemId),
                eq(chatterItems.userId, userId),
            ),
        )
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .innerJoin(
            users,
            and(eq(users.id, recordingFolders.userId), eq(users.role, "org")),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, itemId),
                eq(recordingFolderAssignments.userId, userId),
                eq(chatterItems.userId, userId),
            ),
        )
        .limit(1);
    return row !== undefined;
}

/** Read the durable, owner-scoped facts consumed by the Stage 1 planner. */
export async function gatherFacts(
    itemId: string,
    view: PipelineView,
    userId: string,
): Promise<PipelineFacts> {
    const [processing, [item], [settings], credentials] = await Promise.all([
        readProcessing(itemId, view, userId),
        db
            .select({
                kind: chatterItems.kind,
                deletedAt: chatterItems.deletedAt,
                summaryDueAt: chatterItems.summaryDueAt,
            })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, userId),
                ),
            )
            .limit(1),
        db
            .select({
                autoGenerateTitle: userSettings.autoGenerateTitle,
                autoLearn: userSettings.autoLearn,
                autoSummarize: userSettings.autoSummarize,
                autoSummarizePreset: userSettings.autoSummarizePreset,
                mailAutoProcess: userSettings.mailAutoProcess,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1),
        db
            .select({
                provider: apiCredentials.provider,
                isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
            })
            .from(apiCredentials)
            .where(eq(apiCredentials.userId, userId)),
    ]);

    const missing = !item;
    if (missing) {
        return {
            item: {
                exists: false,
                deleted: false,
                kind: "audio",
                ownerUserId: userId,
            },
            view,
            generation: processing?.requestedGeneration ?? 0,
            content: null,
            summaryDueAt: null,
            settings: settings ?? null,
            hasEnhancementCredential: Boolean(
                pickEnhancementCredential(credentials),
            ),
            mail: null,
            summary: { exists: false, stale: false, jobActive: false },
            phases: processing?.phases ?? {},
            at: new Date().toISOString(),
        };
    }

    const contentPromise: Promise<{
        id: string;
        revision: number;
        timed: boolean;
    } | null> =
        item.kind === "audio"
            ? db
                  .select({
                      id: transcriptions.id,
                      revision: transcriptions.revision,
                      turns: transcriptions.turns,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, userId),
                          eq(transcriptions.source, "riffado"),
                      ),
                  )
                  .limit(1)
                  .then(([row]) =>
                      row
                          ? {
                                id: row.id,
                                revision: row.revision,
                                timed: row.turns !== null,
                            }
                          : null,
                  )
            : db
                  .select({
                      id: mailContents.id,
                      revision: mailContents.revision,
                  })
                  .from(mailContents)
                  .where(
                      and(
                          eq(mailContents.itemId, itemId),
                          eq(mailContents.userId, userId),
                      ),
                  )
                  .limit(1)
                  .then(([row]) =>
                      row
                          ? {
                                id: row.id,
                                revision: row.revision,
                                timed: false,
                            }
                          : null,
                  );
    const mailPromise =
        item.kind === "mail"
            ? db
                  .select({
                      autoGenerated: mailMessages.autoGenerated,
                      unreadable: mailMessages.unreadable,
                  })
                  .from(mailMessages)
                  .where(
                      and(
                          eq(mailMessages.id, itemId),
                          eq(mailMessages.userId, userId),
                      ),
                  )
                  .limit(1)
            : Promise.resolve([]);
    const [content, [mail], [summary], [summaryJob], shared] =
        await Promise.all([
            contentPromise,
            mailPromise,
            db
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, itemId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, "riffado"),
                    ),
                )
                .limit(1),
            db
                .select({ id: asyncJobs.id })
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.userId, userId),
                        eq(asyncJobs.kind, SUMMARY_JOB_KIND),
                        eq(
                            asyncJobs.subjectId,
                            recordingJobSubject(itemId, view),
                        ),
                        inArray(asyncJobs.status, ["pending", "processing"]),
                    ),
                )
                .limit(1),
            item.kind === "mail"
                ? readShared(itemId, userId)
                : Promise.resolve(false),
        ]);
    const summaryExists = summary !== undefined;
    const learn = processing?.phases.learn;
    const releasedCurrentContent =
        item.kind === "audio" &&
        item.summaryDueAt === null &&
        content !== null &&
        learn?.state === "done" &&
        learn.reason === "released" &&
        learn.inputs?.contentId === content.id &&
        learn.inputs.contentSourceId === "riffado" &&
        learn.inputs.contentRevision === content.revision;

    return {
        item: {
            exists: true,
            deleted: item.deletedAt !== null,
            kind: item.kind,
            ownerUserId: userId,
        },
        view,
        generation: processing?.requestedGeneration ?? 0,
        content: content
            ? {
                  contentId: content.id,
                  contentSourceId: item.kind === "audio" ? "riffado" : "mail",
                  contentRevision: content.revision,
                  timed: content.timed,
              }
            : null,
        summaryDueAt: item.summaryDueAt?.toISOString() ?? null,
        settings: settings ?? null,
        hasEnhancementCredential: Boolean(
            pickEnhancementCredential(credentials),
        ),
        mail: item.kind === "mail" && mail ? { ...mail, shared } : null,
        summary: {
            exists: summaryExists,
            stale:
                summaryExists && releasedCurrentContent
                    ? await isSummaryStale(userId, itemId)
                    : false,
            jobActive: summaryJob !== undefined,
        },
        phases: processing?.phases ?? {},
        at: new Date().toISOString(),
    };
}
