import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    chatterItems,
    itemProcessing,
    learnRuns,
    mailContents,
    mailPendingShares,
    processingProfileRevisions,
    processingProfiles,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { getOrgUserId } from "@/lib/org/config";
import type { PipelinePhases } from "@/lib/pipeline/types";
import { parseProfileSettings } from "@/lib/profiles/settings";

export interface ProcessingProfileSummary {
    id: string;
    name: string;
}

export interface ProcessingFolderSummary {
    id: string;
    parentId: string | null;
    name: string;
    path: string;
    scope: "personal" | "org";
}

export interface ItemProcessingPresentation {
    itemId: string;
    kind: "audio" | "mail";
    legacy: boolean;
    manualOnly: boolean;
    phases: PipelinePhases;
    profile:
        | (ProcessingProfileSummary & {
              revisionId: string;
              automatic: {
                  transcribe: boolean;
                  learn: boolean;
                  summary: boolean;
              };
          })
        | null;
    placements: ProcessingFolderSummary[];
    intents: Array<
        Pick<ProcessingFolderSummary, "name" | "path"> & {
            folderId: string;
        }
    >;
    outputs: {
        transcript: boolean;
        summary: boolean;
        learn: boolean;
    };
}

interface StoredFolder {
    id: string;
    userId: string;
    parentId: string | null;
    name: string;
}

async function folderPaths(
    ownerUserId: string,
    orgUserId: string | null,
    directFolders: StoredFolder[],
): Promise<Map<string, ProcessingFolderSummary>> {
    const rowsById = new Map(
        directFolders.map((folder) => [
            folder.id,
            { ...folder, name: decryptText(folder.name) },
        ]),
    );
    const allowedOwners = orgUserId
        ? [...new Set([ownerUserId, orgUserId])]
        : [ownerUserId];
    let parentIds = [
        ...new Set(
            directFolders.flatMap((folder) =>
                folder.parentId ? [folder.parentId] : [],
            ),
        ),
    ];
    while (parentIds.length > 0) {
        const parents = await db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
            })
            .from(recordingFolders)
            .where(
                and(
                    inArray(recordingFolders.id, parentIds),
                    inArray(recordingFolders.userId, allowedOwners),
                ),
            );
        parentIds = [];
        for (const parent of parents) {
            if (rowsById.has(parent.id)) continue;
            rowsById.set(parent.id, {
                ...parent,
                name: decryptText(parent.name),
            });
            if (parent.parentId) parentIds.push(parent.parentId);
        }
        parentIds = [...new Set(parentIds)];
    }

    return new Map(
        directFolders.map((folder) => {
            const parts: string[] = [];
            let current = rowsById.get(folder.id);
            const visited = new Set<string>();
            while (current && !visited.has(current.id)) {
                visited.add(current.id);
                parts.unshift(current.name);
                current = current.parentId
                    ? rowsById.get(current.parentId)
                    : undefined;
            }
            return [
                folder.id,
                {
                    id: folder.id,
                    parentId: folder.parentId,
                    name: decryptText(folder.name),
                    path: parts.join(" › "),
                    scope:
                        orgUserId && folder.userId === orgUserId
                            ? ("org" as const)
                            : ("personal" as const),
                },
            ];
        }),
    );
}

/** Build the owner-only private processing projection used by item headers. */
export async function loadPrivateItemProcessing(
    ownerUserId: string,
    itemId: string,
): Promise<ItemProcessingPresentation | null> {
    const [item] = await db
        .select({
            kind: chatterItems.kind,
            processingItemId: itemProcessing.itemId,
            manualOnly: itemProcessing.manualOnly,
            phases: itemProcessing.phases,
            profileId: processingProfiles.id,
            profileName: processingProfiles.name,
            profileRevisionId: processingProfileRevisions.id,
            profileSettings: processingProfileRevisions.settings,
        })
        .from(chatterItems)
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, chatterItems.id),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .leftJoin(
            processingProfiles,
            eq(processingProfiles.id, itemProcessing.profileId),
        )
        .leftJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    itemProcessing.profileRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return null;

    const [
        orgUserId,
        placementRows,
        intentRows,
        transcripts,
        mailContent,
        summaries,
        finishedLearnRuns,
    ] = await Promise.all([
        getOrgUserId(),
        db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, itemId),
                    eq(recordingFolderAssignments.userId, ownerUserId),
                ),
            ),
        db
            .select({
                id: recordingFolders.id,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
            })
            .from(mailPendingShares)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, mailPendingShares.folderId),
            )
            .where(
                and(
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, ownerUserId),
                ),
            ),
        item.kind === "audio"
            ? db
                  .select({
                      id: transcriptions.id,
                      revision: transcriptions.revision,
                  })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, itemId),
                          eq(transcriptions.userId, ownerUserId),
                          inArray(transcriptions.source, ["riffado", "plaud"]),
                      ),
                  )
            : Promise.resolve([]),
        item.kind === "mail"
            ? db
                  .select({
                      id: mailContents.id,
                      revision: mailContents.revision,
                  })
                  .from(mailContents)
                  .where(
                      and(
                          eq(mailContents.itemId, itemId),
                          eq(mailContents.userId, ownerUserId),
                      ),
                  )
                  .limit(1)
            : Promise.resolve([]),
        db
            .select({
                id: aiEnhancements.id,
                transcriptionId: aiEnhancements.transcriptionId,
                inputs: aiEnhancements.inputs,
            })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, itemId),
                    eq(aiEnhancements.userId, ownerUserId),
                    eq(aiEnhancements.source, "riffado"),
                    isNotNull(aiEnhancements.summary),
                ),
            ),
        db
            .select({
                transcriptionId: learnRuns.transcriptionId,
                transcriptRevision: learnRuns.transcriptRevision,
                inputs: learnRuns.inputs,
            })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, itemId),
                    eq(learnRuns.userId, ownerUserId),
                    eq(learnRuns.view, "private"),
                    eq(learnRuns.status, "finished"),
                ),
            ),
    ]);
    const folderSummaries = await folderPaths(ownerUserId, orgUserId, [
        ...placementRows,
        ...intentRows,
    ]);
    const placements = placementRows.flatMap((folder) => {
        const summary = folderSummaries.get(folder.id);
        return summary ? [summary] : [];
    });
    const intents = intentRows.flatMap((folder) => {
        const summary = folderSummaries.get(folder.id);
        return summary
            ? [
                  {
                      folderId: summary.id,
                      name: summary.name,
                      path: summary.path,
                  },
              ]
            : [];
    });
    const legacy =
        item.processingItemId === null ||
        item.phases?.categorize?.reason === "legacy";
    let automatic: {
        transcribe: boolean;
        learn: boolean;
        summary: boolean;
    } | null = null;
    if (!legacy && item.profileSettings) {
        const storedSettings = JSON.parse(decryptText(item.profileSettings));
        if (item.kind === "audio") {
            const settings = parseProfileSettings("audio", storedSettings);
            automatic = {
                transcribe: settings.steps.transcribe.automatic,
                learn: settings.steps.learn.automatic,
                summary: settings.steps.summary.automatic,
            };
        } else {
            const settings = parseProfileSettings("mail", storedSettings);
            automatic = {
                transcribe: false,
                learn: settings.steps.learn.automatic,
                summary: settings.steps.summary.automatic,
            };
        }
    }
    const profile =
        !legacy &&
        item.profileId &&
        item.profileName &&
        item.profileRevisionId &&
        automatic
            ? {
                  id: item.profileId,
                  name: decryptText(item.profileName),
                  revisionId: item.profileRevisionId,
                  automatic,
              }
            : null;
    const learnDone = finishedLearnRuns.some((run) => {
        const inputs = run.inputs as {
            contentId?: unknown;
            contentRevision?: unknown;
        } | null;
        if (item.kind === "mail") {
            const content = mailContent[0];
            return (
                content !== undefined &&
                run.transcriptionId === null &&
                run.transcriptRevision === content.revision &&
                inputs?.contentId === content.id &&
                inputs.contentRevision === content.revision
            );
        }
        const transcript = transcripts.find(
            (candidate) => candidate.id === run.transcriptionId,
        );
        return (
            transcript !== undefined &&
            run.transcriptRevision === transcript.revision &&
            inputs?.contentId === transcript.id &&
            inputs.contentRevision === transcript.revision
        );
    });
    const summaryCurrent = summaries.some((summary) => {
        const inputs = summary.inputs as {
            contentId?: unknown;
            contentRevision?: unknown;
        } | null;
        if (item.kind === "mail") {
            const content = mailContent[0];
            return (
                content !== undefined &&
                inputs?.contentId === content.id &&
                inputs.contentRevision === content.revision
            );
        }
        const transcript = transcripts.find(
            (candidate) => candidate.id === summary.transcriptionId,
        );
        return (
            transcript !== undefined &&
            (inputs?.contentRevision === undefined ||
                inputs.contentRevision === transcript.revision)
        );
    });

    return {
        itemId,
        kind: item.kind,
        legacy,
        manualOnly: item.manualOnly ?? false,
        phases: item.phases ?? {},
        profile,
        placements,
        intents,
        outputs: {
            transcript: transcripts.length > 0,
            summary: summaryCurrent,
            learn: learnDone,
        },
    };
}
