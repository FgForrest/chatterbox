import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
    chatterItems,
    type EvidenceProvenance,
    mailPendingShares,
    people,
    recordingFolderAssignments,
    recordingTasks,
    taskContentVectors,
    taskMentions,
    taskVectors,
} from "@/db/schema";
import { contentKindColumn, hasContentKind } from "@/lib/content/item-kinds";
import { readItemContent } from "@/lib/content/read-item-content";
import type { ItemContent } from "@/lib/content/types";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import { getTranscriptSpeakers } from "@/lib/knowledge/attribution";
import { embeddingClient } from "@/lib/knowledge/embeddings";
import { vectorGenerationFor } from "@/lib/knowledge/knowledge-embed";
import { findByName, knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    inferSummarySpeakerNumberOffset,
    offsetSpeakerLabel,
    projectSummarySpeakerReferencesForExport,
    speakerAnchorId,
} from "@/lib/knowledge/speaker-references";
import { decodeVector, encodeVector } from "@/lib/knowledge/vector-search";
import { heardIsFirstNameOnly } from "@/lib/learn/name-match";
import { secretAddressMasker } from "@/lib/mail/redact";
import type { AgendaReviewedTask } from "@/lib/meetings/pipeline-context";
import { itemScopeFingerprint } from "@/lib/pipeline/scope-fingerprint";
import {
    ANY_TASK_ITEM,
    assignedToViewer,
    mayMergeTaskOwners,
    type TaskViewer,
    taskClosable,
    taskEditable,
    taskMergeable,
    taskRecordingShared,
    taskVisible,
} from "@/lib/tasks/access";
import {
    buildTasksContext,
    recordingOffsetMinutes,
    type TasksContextTask,
} from "@/lib/tasks/directive";
import {
    linkedTaskMentionCondition,
    taskMentionVisible,
} from "@/lib/tasks/mentions";
import {
    locateQuote,
    locateTextQuote,
    normalizeTaskText,
} from "@/lib/tasks/quote";
import {
    type RankedTaskCandidate,
    rankTaskCandidates,
    rankTaskSearchCandidates,
    TASK_CANDIDATE_LIMIT,
    type TaskRankingCandidate,
    taskContentChunks,
} from "@/lib/tasks/ranking";
import type {
    ProposedTask,
    ProposedTaskMatch,
    ProposedTaskUpdate,
    TaskProposals,
} from "@/lib/tasks/store";
import type {
    SummaryTaskItem,
    SummaryTaskUpdate,
} from "@/lib/tasks/summary-items";
import {
    resolveOfferedTaskReference,
    speakerLabelOf,
} from "@/lib/tasks/summary-items";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** Already-decided tasks of a recording shown to its summary, at most. */
const MAX_DECIDED_IN_PROMPT = 60;
/** A name match at least this good names the person (exact or every word). */
const NAME_MATCH_FLOOR = 0.9;

export const MERGE_CANDIDATE_SCAN_LIMIT = 2_000;

/** The keyed fingerprint a task proposal is recognised by, rejected or kept. */
export function taskFingerprint(text: string): string {
    return domainLookupHash("recording-task", normalizeTaskText(text));
}

export interface TasksPromptContext {
    /** Appended to the summary's system message. */
    text: string;
    /** The `T<n>` references the prompt used, to the tasks they stand for. */
    refs: Map<string, string>;
    /** Folder scope used for this run's task matching. */
    scopeFingerprint: string;
}

interface RecordingRow {
    id: string;
    userId: string;
    occurredAt: Date;
    timezone: number | null;
    zonemins: number | null;
}

interface CandidateTask extends TaskRankingCandidate {
    userId: string;
    dueDate: string | null;
    duePhrase: string | null;
    homeItemId: string;
    homeItemKind: "audio" | "mail";
    homeItemTitle: string;
    assigneeName: string | null;
    shared: boolean;
}

const candidateMentionItem = alias(chatterItems, "candidate_mention_item");
const candidateHomeItem = alias(chatterItems, "candidate_home_item");
const candidateAssignee = alias(people, "candidate_assignee");

function confirmedSpeakerMap(
    rows: Awaited<ReturnType<typeof getTranscriptSpeakers>>,
): Map<string, { label: string; personId: string; name: string }> {
    const byAnchor = new Map<
        string,
        { label: string; personId: string; name: string }
    >();
    for (const row of rows) {
        if (row.status !== "confirmed" || !row.personId || !row.personName) {
            continue;
        }
        byAnchor.set(speakerAnchorId(row.label), {
            label: row.label,
            personId: row.personId,
            name: row.personName,
        });
    }
    return byAnchor;
}

/** Confirmed people on a transcript, by the anchor of their label. */
async function confirmedSpeakers(
    ownerUserId: string,
    transcriptionId: string,
    orgPeopleOnly: boolean,
): Promise<Map<string, { label: string; personId: string; name: string }>> {
    const rows = await getTranscriptSpeakers(ownerUserId, transcriptionId, {
        orgPeopleOnly,
    });
    return confirmedSpeakerMap(rows);
}

async function scopedCandidates(
    recording: Pick<RecordingRow, "id">,
    reviewer: TaskViewer,
    scopeFolderIds: readonly string[],
    excludeCurrentItem = true,
): Promise<CandidateTask[]> {
    const [assigned, pending] = await Promise.all([
        db
            .select({ itemId: recordingFolderAssignments.itemId })
            .from(recordingFolderAssignments)
            .where(
                inArray(recordingFolderAssignments.folderId, [
                    ...scopeFolderIds,
                ]),
            ),
        db
            .select({ itemId: mailPendingShares.itemId })
            .from(mailPendingShares)
            .where(inArray(mailPendingShares.folderId, [...scopeFolderIds])),
    ]);
    const scopedItemIds = [
        ...new Set([...assigned, ...pending].map((row) => row.itemId)),
    ];
    if (scopedItemIds.length === 0) return [];
    const rows = await db
        .select({
            id: recordingTasks.id,
            userId: recordingTasks.userId,
            text: recordingTasks.text,
            assigneePersonId: recordingTasks.assigneePersonId,
            assigneeName: candidateAssignee.displayName,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            homeItemId: candidateHomeItem.id,
            homeItemKind: contentKindColumn(candidateHomeItem.kind),
            homeItemTitle: candidateHomeItem.title,
            shared: sql<boolean>`${taskRecordingShared(reviewer, {
                id: candidateHomeItem.id,
                userId: candidateHomeItem.userId,
            })}`,
            statementAt: taskMentions.statementAt,
        })
        .from(taskMentions)
        .innerJoin(recordingTasks, eq(recordingTasks.id, taskMentions.taskId))
        .innerJoin(
            candidateHomeItem,
            eq(candidateHomeItem.id, recordingTasks.itemId),
        )
        .innerJoin(
            candidateMentionItem,
            eq(candidateMentionItem.id, taskMentions.itemId),
        )
        .leftJoin(
            candidateAssignee,
            eq(candidateAssignee.id, recordingTasks.assigneePersonId),
        )
        .where(
            and(
                eq(recordingTasks.status, "open"),
                ...(excludeCurrentItem
                    ? [ne(recordingTasks.itemId, recording.id)]
                    : []),
                isNull(candidateHomeItem.deletedAt),
                inArray(candidateHomeItem.kind, ["audio", "mail"]),
                taskVisible(reviewer, {
                    id: candidateHomeItem.id,
                    userId: candidateHomeItem.userId,
                }),
                linkedTaskMentionCondition(),
                inArray(taskMentions.itemId, scopedItemIds),
                taskMentionVisible(
                    reviewer,
                    {
                        itemId: taskMentions.itemId,
                        userId: taskMentions.userId,
                        view: taskMentions.view,
                    },
                    {
                        id: candidateMentionItem.id,
                        userId: candidateMentionItem.userId,
                        deletedAt: candidateMentionItem.deletedAt,
                    },
                ),
            ),
        )
        .orderBy(
            desc(taskMentions.statementAt),
            asc(recordingTasks.id),
            asc(taskMentions.id),
        );
    const candidates = new Map<string, CandidateTask>();
    for (const row of rows.filter((row) =>
        hasContentKind(row, "homeItemKind"),
    )) {
        if (candidates.has(row.id)) continue;
        candidates.set(row.id, {
            ...row,
            text: decryptText(row.text),
            duePhrase: row.duePhrase ? decryptText(row.duePhrase) : null,
            assigneeName: row.assigneeName
                ? decryptText(row.assigneeName)
                : null,
            homeItemTitle: decryptText(row.homeItemTitle),
        });
    }
    const values = [...candidates.values()];
    const statements = await visibleStatementTimes(
        reviewer,
        values.map((candidate) => candidate.id),
    );
    return values.map((candidate) => ({
        ...candidate,
        statementAt: statements.get(candidate.id) ?? candidate.statementAt,
    }));
}

async function visibleStatementTimes(
    reviewer: TaskViewer,
    taskIds: readonly string[],
): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (taskIds.length === 0) return result;
    const rows = await db
        .select({
            taskId: taskMentions.taskId,
            statementAt: taskMentions.statementAt,
        })
        .from(taskMentions)
        .innerJoin(
            candidateMentionItem,
            eq(candidateMentionItem.id, taskMentions.itemId),
        )
        .where(
            and(
                inArray(taskMentions.taskId, [...taskIds]),
                linkedTaskMentionCondition(),
                taskMentionVisible(
                    reviewer,
                    {
                        itemId: taskMentions.itemId,
                        userId: taskMentions.userId,
                        view: taskMentions.view,
                    },
                    {
                        id: candidateMentionItem.id,
                        userId: candidateMentionItem.userId,
                        deletedAt: candidateMentionItem.deletedAt,
                    },
                ),
            ),
        )
        .orderBy(
            desc(taskMentions.statementAt),
            asc(taskMentions.taskId),
            asc(taskMentions.id),
        );
    for (const row of rows) {
        if (!result.has(row.taskId)) result.set(row.taskId, row.statementAt);
    }
    return result;
}

async function unfiledCandidates(
    recording: RecordingRow,
    reviewer: TaskViewer,
    participantPersonIds: readonly string[],
): Promise<CandidateTask[]> {
    if (participantPersonIds.length === 0) return [];
    const rows = await db
        .select({
            id: recordingTasks.id,
            userId: recordingTasks.userId,
            text: recordingTasks.text,
            assigneePersonId: recordingTasks.assigneePersonId,
            assigneeName: candidateAssignee.displayName,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            homeItemId: chatterItems.id,
            homeItemKind: contentKindColumn(chatterItems.kind),
            homeItemTitle: chatterItems.title,
            shared: sql<boolean>`${taskRecordingShared(
                reviewer,
                ANY_TASK_ITEM,
            )}`,
            createdAt: recordingTasks.createdAt,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .leftJoin(
            candidateAssignee,
            eq(candidateAssignee.id, recordingTasks.assigneePersonId),
        )
        .where(
            and(
                eq(recordingTasks.status, "open"),
                inArray(recordingTasks.assigneePersonId, [
                    ...participantPersonIds,
                ]),
                ne(recordingTasks.itemId, recording.id),
                isNull(chatterItems.deletedAt),
                or(
                    isNull(chatterItems.id),
                    inArray(chatterItems.kind, ["audio", "mail"]),
                ),
                taskClosable(reviewer, ANY_TASK_ITEM),
            ),
        )
        .orderBy(desc(recordingTasks.createdAt), asc(recordingTasks.id));
    const statements = await visibleStatementTimes(
        reviewer,
        rows.map((row) => row.id),
    );
    return rows
        .filter((row) => hasContentKind(row, "homeItemKind"))
        .map((row) => ({
            id: row.id,
            userId: row.userId,
            text: decryptText(row.text),
            assigneePersonId: row.assigneePersonId,
            assigneeName: row.assigneeName
                ? decryptText(row.assigneeName)
                : null,
            dueDate: row.dueDate,
            duePhrase: row.duePhrase ? decryptText(row.duePhrase) : null,
            homeItemId: row.homeItemId,
            homeItemKind: row.homeItemKind,
            homeItemTitle: decryptText(row.homeItemTitle),
            shared: row.shared,
            statementAt: statements.get(row.id) ?? row.createdAt,
        }));
}

async function currentTaskVectors(
    candidates: readonly CandidateTask[],
    generation: string,
): Promise<Map<string, Float32Array>> {
    if (candidates.length === 0) return new Map();
    const byUser = new Map<string, string[]>();
    for (const candidate of candidates) {
        byUser.set(candidate.userId, [
            ...(byUser.get(candidate.userId) ?? []),
            candidate.id,
        ]);
    }
    const rows = (
        await Promise.all(
            [...byUser].map(([userId, taskIds]) =>
                db
                    .select({
                        taskId: taskVectors.taskId,
                        inputHmac: taskVectors.inputHmac,
                        vector: taskVectors.vector,
                    })
                    .from(taskVectors)
                    .where(
                        and(
                            eq(taskVectors.userId, userId),
                            inArray(taskVectors.taskId, taskIds),
                            eq(taskVectors.vectorGeneration, generation),
                        ),
                    ),
            ),
        )
    ).flat();
    const textById = new Map(
        candidates.map((candidate) => [candidate.id, candidate.text]),
    );
    const vectors = new Map<string, Float32Array>();
    for (const row of rows) {
        const text = textById.get(row.taskId);
        if (text && row.inputHmac === domainLookupHash("vector-input", text)) {
            vectors.set(row.taskId, decodeVector(decryptText(row.vector)));
        }
    }
    return vectors;
}

async function persistTaskVectors(
    candidates: readonly CandidateTask[],
    generation: string,
    vectors: ReadonlyMap<string, Float32Array>,
): Promise<void> {
    const byId = new Map(
        candidates.map((candidate) => [candidate.id, candidate]),
    );
    const rows = [];
    for (const [taskId, vector] of vectors) {
        const candidate = byId.get(taskId);
        if (!candidate) continue;
        rows.push({
            userId: candidate.userId,
            taskId,
            vectorGeneration: generation,
            dim: vector.length,
            vector: encryptText(encodeVector(vector)),
            inputHmac: domainLookupHash("vector-input", candidate.text),
        });
    }
    if (rows.length === 0) return;
    await db
        .insert(taskVectors)
        .values(rows)
        .onConflictDoUpdate({
            target: [taskVectors.taskId, taskVectors.vectorGeneration],
            set: {
                userId: sql`excluded.user_id`,
                dim: sql`excluded.dim`,
                vector: sql`excluded.vector`,
                inputHmac: sql`excluded.input_hmac`,
                createdAt: new Date(),
            },
        });
}

interface ContentVectorKey {
    itemId: string;
    userId: string;
    sourceId: string;
    revision: number;
}

async function currentContentVectors(
    key: ContentVectorKey,
    generation: string,
    text: string,
): Promise<Map<number, Float32Array>> {
    const chunks = taskContentChunks(text);
    const vectors = new Map<number, Float32Array>();
    if (chunks.length === 0) return vectors;
    const rows = await db
        .select({
            chunkIndex: taskContentVectors.chunkIndex,
            inputHmac: taskContentVectors.inputHmac,
            vector: taskContentVectors.vector,
        })
        .from(taskContentVectors)
        .where(
            and(
                eq(taskContentVectors.userId, key.userId),
                eq(taskContentVectors.itemId, key.itemId),
                eq(taskContentVectors.contentSourceId, key.sourceId),
                eq(taskContentVectors.contentRevision, key.revision),
                eq(taskContentVectors.vectorGeneration, generation),
            ),
        )
        .orderBy(asc(taskContentVectors.chunkIndex));
    for (const row of rows) {
        const chunk = chunks[row.chunkIndex];
        if (
            chunk !== undefined &&
            row.inputHmac === domainLookupHash("vector-input", chunk)
        ) {
            vectors.set(row.chunkIndex, decodeVector(decryptText(row.vector)));
        }
    }
    return vectors;
}

/** Persist content vectors without transferring an existing row's ownership. */
export async function persistContentVectors(
    key: ContentVectorKey,
    generation: string,
    chunks: readonly string[],
    vectors: ReadonlyMap<number, Float32Array>,
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx
            .delete(taskContentVectors)
            .where(
                and(
                    eq(taskContentVectors.userId, key.userId),
                    eq(taskContentVectors.itemId, key.itemId),
                    eq(taskContentVectors.contentSourceId, key.sourceId),
                    or(
                        ne(taskContentVectors.contentRevision, key.revision),
                        ne(taskContentVectors.vectorGeneration, generation),
                    ),
                ),
            );
        const rows = [...vectors].flatMap(([index, vector]) => {
            const chunk = chunks[index];
            if (chunk === undefined) return [];
            return [
                {
                    userId: key.userId,
                    itemId: key.itemId,
                    contentSourceId: key.sourceId,
                    contentRevision: key.revision,
                    vectorGeneration: generation,
                    chunkIndex: index,
                    dim: vector.length,
                    vector: encryptText(encodeVector(vector)),
                    inputHmac: domainLookupHash("vector-input", chunk),
                },
            ];
        });
        if (rows.length === 0) return;
        await tx
            .insert(taskContentVectors)
            .values(rows)
            .onConflictDoUpdate({
                target: [
                    taskContentVectors.itemId,
                    taskContentVectors.contentSourceId,
                    taskContentVectors.contentRevision,
                    taskContentVectors.vectorGeneration,
                    taskContentVectors.chunkIndex,
                ],
                set: {
                    dim: sql`excluded.dim`,
                    vector: sql`excluded.vector`,
                    inputHmac: sql`excluded.input_hmac`,
                    createdAt: new Date(),
                },
                setWhere: sql`${taskContentVectors.userId} = excluded.user_id`,
            });
    });
}

async function rankedCandidateEntries(
    candidates: readonly CandidateTask[],
    itemText: string,
    participantPersonIds: readonly string[],
    contentKey?: ContentVectorKey,
): Promise<{
    ranked: RankedTaskCandidate<CandidateTask>[];
    usedEmbeddings: boolean;
}> {
    const client = embeddingClient();
    if (!client) {
        return {
            ranked: rankTaskCandidates({
                itemText,
                participantPersonIds,
                candidates,
            }),
            usedEmbeddings: false,
        };
    }
    try {
        const generation = vectorGenerationFor(client.model);
        const contentChunks = taskContentChunks(itemText);
        if (contentChunks.length === 0) {
            return {
                ranked: rankTaskCandidates({
                    itemText,
                    participantPersonIds,
                    candidates,
                }),
                usedEmbeddings: false,
            };
        }
        const [taskVectorMap, contentVectorMap] = await Promise.all([
            currentTaskVectors(candidates, generation),
            contentKey
                ? currentContentVectors(contentKey, generation, itemText)
                : Promise.resolve(new Map<number, Float32Array>()),
        ]);
        type PendingEmbedding =
            | { kind: "content"; index: number; text: string }
            | { kind: "task"; candidate: CandidateTask; text: string };
        const pending: PendingEmbedding[] = [
            ...contentChunks.flatMap((text, index) =>
                contentVectorMap.has(index)
                    ? []
                    : [{ kind: "content" as const, index, text }],
            ),
            ...candidates.flatMap((candidate) =>
                taskVectorMap.has(candidate.id)
                    ? []
                    : [
                          {
                              kind: "task" as const,
                              candidate,
                              text: candidate.text,
                          },
                      ],
            ),
        ];
        const persisted = new Set<number>();
        const acceptBatch = async (
            start: number,
            vectors: readonly Float32Array[],
        ) => {
            const taskVectorsToPersist = new Map<string, Float32Array>();
            const contentVectorsToPersist = new Map<number, Float32Array>();
            for (const [offset, vector] of vectors.entries()) {
                const requestIndex = start + offset;
                if (persisted.has(requestIndex)) continue;
                const request = pending[requestIndex];
                if (!request) {
                    throw new Error(
                        "The embedding response does not match the request",
                    );
                }
                persisted.add(requestIndex);
                if (request.kind === "content") {
                    contentVectorMap.set(request.index, vector);
                    contentVectorsToPersist.set(request.index, vector);
                } else {
                    taskVectorMap.set(request.candidate.id, vector);
                    taskVectorsToPersist.set(request.candidate.id, vector);
                }
            }
            await Promise.all([
                persistTaskVectors(
                    candidates,
                    generation,
                    taskVectorsToPersist,
                ),
                contentKey
                    ? persistContentVectors(
                          contentKey,
                          generation,
                          contentChunks,
                          contentVectorsToPersist,
                      )
                    : Promise.resolve(),
            ]);
        };
        if (pending.length > 0) {
            const vectors = await client.embed(
                pending.map((request) => request.text),
                {
                    onBatch: (batch) => acceptBatch(batch.start, batch.vectors),
                },
            );
            if (vectors.length !== pending.length) {
                throw new Error(
                    "The embedding response does not match the request",
                );
            }
            await acceptBatch(0, vectors);
        }
        const itemVectors: Float32Array[] = [];
        for (const index of contentChunks.keys()) {
            const vector = contentVectorMap.get(index);
            if (!vector) {
                throw new Error("The embedding response omitted content");
            }
            itemVectors.push(vector);
        }
        const withVectors = candidates.map((candidate) => {
            const vector = taskVectorMap.get(candidate.id);
            if (!vector) {
                throw new Error("The embedding response omitted a task");
            }
            return { ...candidate, vector };
        });
        return {
            ranked: rankTaskCandidates({
                itemText,
                participantPersonIds,
                candidates: withVectors,
                itemVectors,
            }),
            usedEmbeddings: true,
        };
    } catch (error) {
        console.warn(
            "[tasks] task vectors unavailable; using word overlap:",
            error,
        );
        return {
            ranked: rankTaskCandidates({
                itemText,
                participantPersonIds,
                candidates,
            }),
            usedEmbeddings: false,
        };
    }
}

async function rankedCandidates(
    candidates: readonly CandidateTask[],
    itemText: string,
    participantPersonIds: readonly string[],
): Promise<CandidateTask[]> {
    return (
        await rankedCandidateEntries(candidates, itemText, participantPersonIds)
    ).ranked
        .slice(0, TASK_CANDIDATE_LIMIT)
        .map((entry) => entry.candidate);
}

export interface MergeCandidateView {
    id: string;
    text: string;
    dueDate: string | null;
    duePhrase: string | null;
    assignee: { personId: string; name: string } | null;
    homeItem: {
        id: string;
        kind: "audio" | "mail";
        title: string;
    } | null;
    version?: number;
}

export interface MergeCandidatePage {
    candidates: MergeCandidateView[];
    nextOffset: number | null;
}

/** Search every mergeable open task in an item's folder scope. */
export async function searchMergeCandidates(
    reviewer: TaskViewer,
    itemId: string,
    query: {
        text: string;
        sourceTaskId?: string | null;
        offset: number;
        limit: number;
    },
): Promise<MergeCandidatePage> {
    const text = query.text.trim();
    const [item] = await db
        .select({
            id: chatterItems.id,
            userId: chatterItems.userId,
            kind: contentKindColumn(chatterItems.kind),
            title: chatterItems.title,
            occurredAt: chatterItems.occurredAt,
            shared: sql<boolean>`${taskRecordingShared(
                reviewer,
                ANY_TASK_ITEM,
            )}`,
            canReview: sql<boolean>`${taskEditable(reviewer, ANY_TASK_ITEM)}`,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                isNull(chatterItems.deletedAt),
                inArray(chatterItems.kind, ["audio", "mail"]),
            ),
        )
        .limit(1);
    if (!item?.canReview) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Merge search is limited to the item's owner or a curator",
            403,
        );
    }
    const [source] = query.sourceTaskId
        ? await db
              .select({
                  id: recordingTasks.id,
                  userId: recordingTasks.userId,
                  status: recordingTasks.status,
              })
              .from(recordingTasks)
              .where(
                  and(
                      eq(recordingTasks.id, query.sourceTaskId),
                      eq(recordingTasks.itemId, item.id),
                      eq(recordingTasks.userId, item.userId),
                  ),
              )
              .limit(1)
        : [];
    if (query.sourceTaskId && !source) {
        throw new AppError(ErrorCode.NOT_FOUND, "Task not found", 404);
    }
    const scopeFolderIds = await itemScopeFolderIds(
        item.id,
        item.shared ? "org" : "private",
        item.userId,
    );
    if (scopeFolderIds.length === 0) {
        return { candidates: [], nextOffset: null };
    }
    const eligible = (
        await scopedCandidates(item, reviewer, scopeFolderIds, false)
    )
        .filter((candidate) => candidate.id !== query.sourceTaskId)
        .filter((candidate) => {
            if (!source || source.status === "proposed") return true;
            return mayMergeTaskOwners(
                reviewer,
                source.userId,
                candidate.userId,
            );
        })
        .filter((candidate) => candidate.shared === item.shared);
    const content = text ? null : await readItemContent(item.userId, item.id);
    const rankingText = text
        ? text
        : [
              ...(item.kind === "mail" ? [decryptText(item.title)] : []),
              ...(content?.segments.flatMap((segment) =>
                  segment.knownItemId ? [] : [segment.text],
              ) ?? []),
          ].join("\n");
    const participantPersonIds = text
        ? []
        : [
              ...new Set(
                  content?.participants.flatMap((participant) =>
                      participant.personId ? [participant.personId] : [],
                  ) ?? [],
              ),
          ];
    const ranking = await rankedCandidateEntries(
        eligible,
        rankingText,
        participantPersonIds,
        content
            ? {
                  itemId: item.id,
                  userId: item.userId,
                  sourceId: content.sourceId,
                  revision: content.revision,
              }
            : undefined,
    );
    const matching = text
        ? rankTaskSearchCandidates(ranking.ranked, text, ranking.usedEmbeddings)
        : ranking.ranked;
    const page = matching.slice(query.offset, query.offset + query.limit);
    const nextOffset =
        query.offset + page.length < matching.length
            ? query.offset + page.length
            : null;
    return {
        candidates: page.map(({ candidate }) => ({
            id: candidate.id,
            text: candidate.text,
            dueDate: candidate.dueDate,
            duePhrase: candidate.duePhrase,
            assignee:
                candidate.assigneePersonId && candidate.assigneeName
                    ? {
                          personId: candidate.assigneePersonId,
                          name: candidate.assigneeName,
                      }
                    : null,
            homeItem: {
                id: candidate.homeItemId,
                kind: candidate.homeItemKind,
                title: candidate.homeItemTitle,
            },
        })),
        nextOffset,
    };
}

/**
 * What a summary of `recording` is told about tasks: its date, tasks already
 * decided on it, and ranked open tasks with linked visible mentions in its
 * folder scope. Before filing, the earlier participant-based set is used.
 */
export async function loadTasksPromptContext({
    recording,
    transcriptionId,
    orgView,
    reviewer,
    noun,
    language = null,
    participants = [],
    itemText = "",
    agendaTasks = [],
}: {
    recording: RecordingRow;
    /** The transcript its speakers are confirmed on; null for a mail. */
    transcriptionId: string | null;
    orgView: boolean;
    reviewer: TaskViewer;
    noun?: "recording" | "mail";
    language?: string | null;
    participants?: readonly Pick<
        ItemContent["participants"][number],
        "ref" | "personId"
    >[];
    /** Plain item content used only to rank visible candidate tasks. */
    itemText?: string;
    agendaTasks?: readonly AgendaReviewedTask[];
}): Promise<TasksPromptContext> {
    const decidedRows = await db
        .select({ text: recordingTasks.text })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recording.id),
                eq(recordingTasks.userId, recording.userId),
                ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(recordingTasks.position, recordingTasks.createdAt)
        .limit(MAX_DECIDED_IN_PROMPT);

    const transcriptSpeakerRows = transcriptionId
        ? await getTranscriptSpeakers(recording.userId, transcriptionId, {
              orgPeopleOnly: orgView,
          })
        : [];
    const speakers = confirmedSpeakerMap(transcriptSpeakerRows);
    const labelOf = new Map(
        [...speakers.values()].map((speaker) => [
            speaker.personId,
            speaker.label,
        ]),
    );
    for (const participant of participants) {
        if (participant.personId && !labelOf.has(participant.personId)) {
            labelOf.set(participant.personId, participant.ref);
        }
    }
    const participantPersonIds = [
        ...new Set([
            ...transcriptSpeakerRows.flatMap((speaker) =>
                speaker.personId ? [speaker.personId] : [],
            ),
            ...participants.flatMap((participant) =>
                participant.personId ? [participant.personId] : [],
            ),
        ]),
    ];
    const refs = new Map<string, string>();
    const open: TasksContextTask[] = [];
    const scopeFolderIds = await itemScopeFolderIds(
        recording.id,
        orgView ? "org" : "private",
        recording.userId,
    );
    const eligible =
        scopeFolderIds.length > 0
            ? await scopedCandidates(recording, reviewer, scopeFolderIds)
            : await unfiledCandidates(recording, reviewer, [...labelOf.keys()]);
    const reviewedIds = new Set(agendaTasks.map((task) => task.id));
    const ranked = await rankedCandidates(
        eligible.filter((task) => !reviewedIds.has(task.id)),
        itemText,
        participantPersonIds,
    );
    const rows = [
        ...agendaTasks
            .filter(
                (task) =>
                    !task.changedDuringMeeting &&
                    ["open", "done"].includes(task.status),
            )
            .map((task) => ({ ...task })),
        ...ranked,
    ].slice(0, TASK_CANDIDATE_LIMIT);
    rows.forEach((row, index) => {
        const ref = `T${index + 1}`;
        refs.set(ref, row.id);
        open.push({
            ref,
            text: row.text,
            speaker: row.assigneePersonId
                ? (labelOf.get(row.assigneePersonId) ?? null)
                : null,
            assigneeName: row.assigneeName
                ? decryptText(row.assigneeName)
                : null,
            dueDate: row.dueDate,
            ...("status" in row ? { status: row.status } : {}),
        });
    });

    const text = buildTasksContext({
        noun,
        recordedAt: recording.occurredAt,
        offsetMinutes: recordingOffsetMinutes(
            recording.timezone,
            recording.zonemins,
        ),
        language,
        decided: [
            ...decidedRows.map((row) => decryptText(row.text)),
            ...agendaTasks
                .filter((task) => task.changedDuringMeeting)
                .map((task) => task.text),
        ],
        open,
    });
    const mask = await secretAddressMasker([text]);
    return {
        text: mask(text),
        refs,
        scopeFingerprint: await itemScopeFingerprint(
            recording.id,
            orgView ? "org" : "private",
            recording.userId,
        ),
    };
}

/**
 * Turn a summary's items into proposals: a speaker label becomes the person
 * confirmed on it, a heard name the one person of the Almanac it fully
 * names (marked for a check when only a first name was heard), speaker
 * references in the text become names, and a quote its place in the audio.
 * On a mail a participant reference becomes their name to look up, and a
 * quote its place in the text, with its provenance.
 */
export async function resolveTaskProposals({
    source,
    items,
    updates,
    refs,
    ownerUserId,
    transcriptionId,
    turns,
    language,
    orgView,
    reviewer,
    summaryText,
    mail = null,
}: {
    source: "riffado" | "plaud";
    items: readonly SummaryTaskItem[];
    updates: readonly SummaryTaskUpdate[];
    refs: ReadonlyMap<string, string>;
    ownerUserId: string;
    transcriptionId: string | null;
    turns: readonly TranscriptTurn[] | null;
    language: string | null;
    orgView: boolean;
    reviewer: TaskViewer;
    /** The summary's Markdown, to tell how its speaker numbers count. */
    summaryText: string;
    /** The content of the mail the summary is of. */
    mail?: ItemContent | null;
}): Promise<TaskProposals> {
    const participantOf = (ref: string) =>
        mail?.participants.find((participant) => participant.ref === ref);
    const participantName = (ref: string) =>
        participantOf(ref)?.displayName ?? null;
    const evidence = (quote: string | null) =>
        mail
            ? mailEvidence(mail, quote, language)
            : {
                  evidenceStartMs: locateQuote(turns, quote, language),
                  quotedAt: null,
              };
    const speakers = transcriptionId
        ? await confirmedSpeakers(ownerUserId, transcriptionId, orgView)
        : new Map<string, { label: string; personId: string; name: string }>();
    const nameOf = (label: string) =>
        speakers.get(speakerAnchorId(label))?.name ?? null;
    const offset = inferSummarySpeakerNumberOffset(
        [
            summaryText,
            ...items.map((item) => item.text),
            ...updates.flatMap((update) =>
                update.kind === "assignee" && update.assignee
                    ? [update.assignee]
                    : [],
            ),
        ].join("\n"),
        (turns ?? []).map((turn) => turn.speaker),
    );

    const needsLookup =
        items.some(
            (item) =>
                (!item.speaker && item.assignee) ||
                (mail && item.speaker && participantName(item.speaker)),
        ) ||
        updates.some((update) => {
            if (update.kind !== "assignee" || !update.assignee) return false;
            const ref = speakerLabelOf(update.assignee);
            return !ref || Boolean(mail && participantName(ref));
        });
    const view = needsLookup
        ? await knowledgeView({
              kind: "recording",
              ownerUserId,
              shared: orgView,
          })
        : null;

    const tasks: ProposedTask[] = [];
    const resolveAssignee = (
        speaker: string | null,
        namedAssignee: string | null,
    ): {
        assigneePersonId: string | null;
        assigneeHint: string | null;
        assigneeCheck: boolean;
    } => {
        let assigneePersonId: string | null = null;
        let assigneeHint: string | null = null;
        let assigneeCheck = false;
        const heard = mail
            ? (namedAssignee ?? (speaker ? participantName(speaker) : null))
            : namedAssignee;
        const known = mail && speaker ? participantOf(speaker) : undefined;
        if (known?.personId) {
            assigneePersonId = known.personId;
        } else if (mail) {
            const person =
                heard && view ? matchPerson(view, heard, language) : null;
            if (person) {
                assigneePersonId = person.id;
                assigneeCheck = heardIsFirstNameOnly(heard ?? "", {
                    name: person.name,
                    aliases: person.aliases,
                });
            } else {
                assigneeHint = heard;
            }
        } else if (speaker) {
            const resolvedSpeaker = speakers.get(
                speakerAnchorId(offsetSpeakerLabel(speaker, offset)),
            );
            if (resolvedSpeaker) {
                assigneePersonId = resolvedSpeaker.personId;
                assigneeCheck = offset !== 0;
            }
        } else if (namedAssignee && view) {
            const person = matchPerson(view, namedAssignee, language);
            if (person) {
                assigneePersonId = person.id;
                assigneeCheck = heardIsFirstNameOnly(namedAssignee, {
                    name: person.name,
                    aliases: person.aliases,
                });
            } else {
                assigneeHint = namedAssignee;
            }
        }
        if (assigneeCheck) {
            assigneeHint =
                heard ??
                (speaker ? nameOf(offsetSpeakerLabel(speaker, offset)) : null);
        }
        return { assigneePersonId, assigneeHint, assigneeCheck };
    };
    for (const item of items) {
        const text = projectSummarySpeakerReferencesForExport(
            item.text,
            nameOf,
            offset,
        ).trim();
        if (!text) continue;
        const { assigneePersonId, assigneeHint, assigneeCheck } =
            resolveAssignee(item.speaker, item.assignee);
        const candidateTaskIds = [
            ...new Set(
                (item.candidates ?? []).flatMap((ref) => {
                    const taskId = resolveOfferedTaskReference(ref, refs);
                    if (taskId) return [taskId];
                    return [];
                }),
            ),
        ];
        tasks.push({
            text,
            fingerprint: taskFingerprint(text),
            assigneePersonId,
            assigneeHint,
            assigneeCheck,
            dueDate: item.due?.date ?? null,
            duePhrase: item.due?.phrase ?? null,
            quote: item.quote,
            candidateTaskIds,
            ...evidence(item.quote),
        });
    }

    const matches: ProposedTaskMatch[] = [];
    const proposedUpdates: ProposedTaskUpdate[] = [];
    const matched = new Set<string>();
    for (const update of updates) {
        const taskId = resolveOfferedTaskReference(update.ref, refs);
        if (!taskId) {
            continue;
        }
        const located = evidence(update.quote);
        if (update.kind === "match") {
            if (matched.has(taskId)) continue;
            matched.add(taskId);
            matches.push({
                taskId,
                quote: update.quote,
                ...located,
            });
            continue;
        }
        const assigneeRef =
            update.kind === "assignee" ? speakerLabelOf(update.assignee) : null;
        const proposedAssignee =
            update.kind === "assignee"
                ? resolveAssignee(
                      assigneeRef,
                      assigneeRef ? null : (update.assignee ?? null),
                  )
                : {
                      assigneePersonId: null,
                      assigneeHint: null,
                      assigneeCheck: false,
                  };
        proposedUpdates.push({
            taskId,
            kind: update.kind,
            dueDate: update.due?.date ?? null,
            duePhrase: update.due?.phrase ?? null,
            ...proposedAssignee,
            quote: update.quote,
            ...located,
            ticked: false,
        });
    }

    return {
        source,
        tasks,
        matches,
        updates: proposedUpdates,
        reviewer,
        fingerprintOf: taskFingerprint,
    };
}

/**
 * Where in a mail a quote is, and how far to trust it: a quoted part was
 * written by someone else earlier, and a sender nothing verified may not be
 * who they say. Words not found anywhere may be from either: unless the
 * sender is verified and the mail quotes nothing, they are checked too.
 */
function mailEvidence(
    mail: ItemContent,
    quote: string | null,
    language: string | null,
): Pick<
    ProposedTask,
    "evidenceStartMs" | "evidenceText" | "evidenceProvenance" | "quotedAt"
> {
    const readable = mail.segments.filter(
        (segment) => !segment.knownItemId && segment.role !== "disclaimer",
    );
    const range = locateTextQuote(readable, quote, language);
    const segment = range
        ? mail.segments.find((item) => item.index === range.segmentIndex)
        : undefined;
    const authorOf = (ref: string | null | undefined) =>
        ref
            ? mail.participants.find((participant) => participant.ref === ref)
            : undefined;
    let provenance: EvidenceProvenance | null;
    if (segment) {
        provenance =
            segment.role === "quoted" || segment.role === "quoted_signature"
                ? "quoted"
                : authorOf(segment.participantRef)?.authenticated
                  ? null
                  : "unverified";
    } else {
        const sender = mail.participants.find((participant) =>
            participant.roles.includes("from"),
        );
        provenance = !sender?.authenticated
            ? "unverified"
            : readable.some(
                    (part) =>
                        part.role === "quoted" ||
                        part.role === "quoted_signature",
                )
              ? "unlocated"
              : null;
    }
    return {
        evidenceStartMs: null,
        evidenceText: range,
        evidenceProvenance: provenance,
        quotedAt: provenance === "quoted" ? (segment?.at ?? null) : null,
    };
}

function matchPerson(
    view: Awaited<ReturnType<typeof knowledgeView>>,
    heard: string,
    language: string | null,
): { id: string; name: string; aliases: string[] } | null {
    const people = new Map(
        view.items
            .filter((item) => item.kind === "person")
            .map((item) => [item.id, item]),
    );
    const matches = findByName(view, heard, language).filter(
        (match) => people.has(match.id) && match.score >= NAME_MATCH_FLOOR,
    );
    const [best, second] = matches;
    if (!best || (second && second.score === best.score)) return null;
    const person = people.get(best.id);
    if (!person) return null;
    return {
        id: person.id,
        name: person.name,
        aliases: person.names
            .filter((name) => name.kind === "alias")
            .map((name) => name.text),
    };
}

/** Offer the assignee's other open tasks across all visible items and own tasks. */
export async function searchAssignedMergeCandidates(
    viewer: TaskViewer,
    taskId: string,
    query: { text: string; offset: number; limit: number },
): Promise<MergeCandidatePage | null> {
    const [source] = await db
        .select({
            text: recordingTasks.text,
            itemId: recordingTasks.itemId,
            canEdit: sql<boolean>`${taskEditable(viewer, ANY_TASK_ITEM, true)}`,
        })
        .from(recordingTasks)
        .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                eq(recordingTasks.id, taskId),
                eq(recordingTasks.status, "open"),
                taskMergeable(viewer, ANY_TASK_ITEM),
                assignedToViewer(viewer),
                isNull(chatterItems.deletedAt),
                or(
                    isNull(chatterItems.id),
                    inArray(chatterItems.kind, ["audio", "mail"]),
                ),
            ),
        )
        .limit(1);
    if (!source) return null;
    const rows = await db
        .select({
            id: recordingTasks.id,
            text: recordingTasks.text,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            version: recordingTasks.version,
            createdAt: recordingTasks.createdAt,
            assigneePersonId: recordingTasks.assigneePersonId,
            assigneeName: people.displayName,
            itemId: chatterItems.id,
            kind: contentKindColumn(chatterItems.kind),
            title: chatterItems.title,
        })
        .from(recordingTasks)
        .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .leftJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                ne(recordingTasks.id, taskId),
                eq(recordingTasks.status, "open"),
                taskMergeable(viewer, ANY_TASK_ITEM),
                or(
                    assignedToViewer(viewer),
                    source.canEdit && source.itemId
                        ? eq(recordingTasks.itemId, source.itemId)
                        : undefined,
                ),
                isNull(chatterItems.deletedAt),
                or(
                    isNull(chatterItems.id),
                    inArray(chatterItems.kind, ["audio", "mail"]),
                ),
            ),
        )
        .orderBy(desc(recordingTasks.createdAt), asc(recordingTasks.id))
        .limit(MERGE_CANDIDATE_SCAN_LIMIT);
    const candidates = rows.map((row) => ({
        ...row,
        text: decryptText(row.text),
        statementAt: row.createdAt,
    }));
    const ranked = rankTaskCandidates({
        itemText: query.text || decryptText(source.text),
        participantPersonIds: [],
        candidates,
    });
    const matching = query.text
        ? rankTaskSearchCandidates(ranked, query.text, false)
        : ranked;
    const page = matching.slice(query.offset, query.offset + query.limit);
    return {
        candidates: page.map(({ candidate: row }) => ({
            id: row.id,
            version: row.version,
            text: row.text,
            dueDate: row.dueDate,
            duePhrase: row.duePhrase ? decryptText(row.duePhrase) : null,
            assignee:
                row.assigneePersonId && row.assigneeName
                    ? {
                          personId: row.assigneePersonId,
                          name: decryptText(row.assigneeName),
                      }
                    : null,
            homeItem:
                row.itemId && row.kind && row.title
                    ? {
                          id: row.itemId,
                          kind: row.kind,
                          title: decryptText(row.title),
                      }
                    : null,
        })),
        nextOffset:
            query.offset + page.length < matching.length
                ? query.offset + page.length
                : null,
    };
}
