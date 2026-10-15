import {
    and,
    asc,
    desc,
    eq,
    exists,
    inArray,
    isNull,
    ne,
    or,
    sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
    chatterItems,
    type EvidenceProvenance,
    mailPendingShares,
    recordingFolderAssignments,
    recordingTasks,
    taskMentions,
    taskVectors,
} from "@/db/schema";
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
import { itemScopeFingerprint } from "@/lib/pipeline/scope-fingerprint";
import {
    ANY_TASK_ITEM,
    mayMergeTaskOwners,
    type TaskViewer,
    taskClosable,
    taskEditable,
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
    rankTaskCandidatesWithEmbeddings,
    rankTaskSearchCandidates,
    TASK_CANDIDATE_LIMIT,
    type TaskRankingCandidate,
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
    shouldPreselectTaskOutcome,
} from "@/lib/tasks/summary-items";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** Already-decided tasks of a recording shown to its summary, at most. */
const MAX_DECIDED_IN_PROMPT = 60;
/** A name match at least this good names the person (exact or every word). */
const NAME_MATCH_FLOOR = 0.9;

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
    shared: boolean;
}

const candidateMentionItem = alias(chatterItems, "candidate_mention_item");
const candidateHomeItem = alias(chatterItems, "candidate_home_item");

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
): Promise<CandidateTask[]> {
    const inActualPlacement = exists(
        db
            .select({ itemId: recordingFolderAssignments.itemId })
            .from(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, taskMentions.itemId),
                    eq(recordingFolderAssignments.userId, taskMentions.userId),
                    inArray(recordingFolderAssignments.folderId, [
                        ...scopeFolderIds,
                    ]),
                ),
            ),
    );
    const inIntendedPlacement = exists(
        db
            .select({ itemId: mailPendingShares.itemId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, taskMentions.itemId),
                    eq(mailPendingShares.userId, taskMentions.userId),
                    inArray(mailPendingShares.folderId, [...scopeFolderIds]),
                ),
            ),
    );
    const rows = await db
        .select({
            id: recordingTasks.id,
            userId: recordingTasks.userId,
            text: recordingTasks.text,
            assigneePersonId: recordingTasks.assigneePersonId,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            homeItemId: candidateHomeItem.id,
            homeItemKind: candidateHomeItem.kind,
            homeItemTitle: candidateHomeItem.title,
            shared: sql<boolean>`${taskRecordingShared(reviewer, {
                id: candidateHomeItem.id,
                userId: candidateHomeItem.userId,
            })}`,
            statementAt: taskMentions.statementAt,
        })
        .from(recordingTasks)
        .innerJoin(taskMentions, eq(taskMentions.taskId, recordingTasks.id))
        .innerJoin(
            candidateHomeItem,
            eq(candidateHomeItem.id, recordingTasks.itemId),
        )
        .innerJoin(
            candidateMentionItem,
            eq(candidateMentionItem.id, taskMentions.itemId),
        )
        .where(
            and(
                eq(recordingTasks.status, "open"),
                ne(recordingTasks.itemId, recording.id),
                isNull(candidateHomeItem.deletedAt),
                taskVisible(reviewer, {
                    id: candidateHomeItem.id,
                    userId: candidateHomeItem.userId,
                }),
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
                or(inActualPlacement, inIntendedPlacement),
            ),
        )
        .orderBy(
            desc(taskMentions.statementAt),
            asc(recordingTasks.id),
            asc(taskMentions.id),
        );
    const candidates = new Map<string, CandidateTask>();
    for (const row of rows) {
        if (candidates.has(row.id)) continue;
        candidates.set(row.id, {
            ...row,
            text: decryptText(row.text),
            duePhrase: row.duePhrase ? decryptText(row.duePhrase) : null,
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
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            homeItemId: chatterItems.id,
            homeItemKind: chatterItems.kind,
            homeItemTitle: chatterItems.title,
            shared: sql<boolean>`${taskRecordingShared(
                reviewer,
                ANY_TASK_ITEM,
            )}`,
            createdAt: recordingTasks.createdAt,
        })
        .from(recordingTasks)
        .innerJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                eq(recordingTasks.status, "open"),
                inArray(recordingTasks.assigneePersonId, [
                    ...participantPersonIds,
                ]),
                ne(recordingTasks.itemId, recording.id),
                isNull(chatterItems.deletedAt),
                taskClosable(reviewer, ANY_TASK_ITEM),
            ),
        )
        .orderBy(desc(recordingTasks.createdAt), asc(recordingTasks.id));
    const statements = await visibleStatementTimes(
        reviewer,
        rows.map((row) => row.id),
    );
    return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        text: decryptText(row.text),
        assigneePersonId: row.assigneePersonId,
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
    for (const [taskId, vector] of vectors) {
        const candidate = byId.get(taskId);
        if (!candidate) continue;
        await db
            .insert(taskVectors)
            .values({
                userId: candidate.userId,
                taskId,
                vectorGeneration: generation,
                dim: vector.length,
                vector: encryptText(encodeVector(vector)),
                inputHmac: domainLookupHash("vector-input", candidate.text),
            })
            .onConflictDoUpdate({
                target: [taskVectors.taskId, taskVectors.vectorGeneration],
                set: {
                    userId: candidate.userId,
                    dim: vector.length,
                    vector: encryptText(encodeVector(vector)),
                    inputHmac: domainLookupHash("vector-input", candidate.text),
                    createdAt: new Date(),
                },
            });
    }
}

async function rankedCandidateEntries(
    candidates: readonly CandidateTask[],
    itemText: string,
    participantPersonIds: readonly string[],
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
        const held = await currentTaskVectors(candidates, generation);
        const withVectors = candidates.map((candidate) => ({
            ...candidate,
            vector: held.get(candidate.id) ?? null,
        }));
        const result = await rankTaskCandidatesWithEmbeddings(
            {
                itemText,
                participantPersonIds,
                candidates: withVectors,
            },
            {
                embed: (texts) => client.embed(texts),
                onEmbeddingFailure: (error) => {
                    console.warn(
                        "[tasks] embedding ranking unavailable; using word overlap:",
                        error,
                    );
                },
            },
        );
        if (result.usedEmbeddings && result.generatedVectors.size > 0) {
            await persistTaskVectors(
                candidates,
                generation,
                result.generatedVectors,
            );
        }
        return {
            ranked: result.ranked,
            usedEmbeddings: result.usedEmbeddings,
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
    homeItem: {
        id: string;
        kind: "audio" | "mail";
        title: string;
    };
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
            kind: chatterItems.kind,
            title: chatterItems.title,
            occurredAt: chatterItems.occurredAt,
            shared: sql<boolean>`${taskRecordingShared(
                reviewer,
                ANY_TASK_ITEM,
            )}`,
            canReview: sql<boolean>`${taskEditable(reviewer, ANY_TASK_ITEM)}`,
        })
        .from(chatterItems)
        .where(and(eq(chatterItems.id, itemId), isNull(chatterItems.deletedAt)))
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
    const eligible = (await scopedCandidates(item, reviewer, scopeFolderIds))
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
    participants = [],
    itemText = "",
}: {
    recording: RecordingRow;
    /** The transcript its speakers are confirmed on; null for a mail. */
    transcriptionId: string | null;
    orgView: boolean;
    reviewer: TaskViewer;
    noun?: "recording" | "mail";
    participants?: readonly Pick<
        ItemContent["participants"][number],
        "ref" | "personId"
    >[];
    /** Plain item content used only to rank visible candidate tasks. */
    itemText?: string;
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
    const rows = await rankedCandidates(
        eligible,
        itemText,
        participantPersonIds,
    );
    rows.forEach((row, index) => {
        const ref = `T${index + 1}`;
        refs.set(ref, row.id);
        open.push({
            ref,
            text: row.text,
            speaker: row.assigneePersonId
                ? (labelOf.get(row.assigneePersonId) ?? null)
                : null,
            dueDate: row.dueDate,
        });
    });

    return {
        text: buildTasksContext({
            noun,
            recordedAt: recording.occurredAt,
            offsetMinutes: recordingOffsetMinutes(
                recording.timezone,
                recording.zonemins,
            ),
            decided: decidedRows.map((row) => decryptText(row.text)),
            open,
        }),
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
            ? mailEvidence(mail, quote)
            : { evidenceStartMs: locateQuote(turns, quote), quotedAt: null };
    const speakers = transcriptionId
        ? await confirmedSpeakers(ownerUserId, transcriptionId, orgView)
        : new Map<string, { label: string; personId: string; name: string }>();
    const nameOf = (label: string) =>
        speakers.get(speakerAnchorId(label))?.name ?? null;
    const offset = inferSummarySpeakerNumberOffset(
        [summaryText, ...items.map((item) => item.text)].join("\n"),
        (turns ?? []).map((turn) => turn.speaker),
    );

    const needsLookup = items.some(
        (item) =>
            (!item.speaker && item.assignee) ||
            (mail && item.speaker && participantName(item.speaker)),
    );
    const view = needsLookup
        ? await knowledgeView({
              kind: "recording",
              ownerUserId,
              shared: orgView,
          })
        : null;

    const tasks: ProposedTask[] = [];
    for (const item of items) {
        const text = projectSummarySpeakerReferencesForExport(
            item.text,
            nameOf,
            offset,
        ).trim();
        if (!text) continue;
        let assigneePersonId: string | null = null;
        let assigneeHint: string | null = null;
        let assigneeCheck = false;
        const heard = mail
            ? (item.assignee ??
              (item.speaker ? participantName(item.speaker) : null))
            : null;
        const known =
            mail && item.speaker ? participantOf(item.speaker) : undefined;
        if (known?.personId) {
            // The participant's address is the person's: no guess.
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
        } else if (item.speaker) {
            const speaker = speakers.get(
                speakerAnchorId(offsetSpeakerLabel(item.speaker, offset)),
            );
            if (speaker) {
                assigneePersonId = speaker.personId;
                // The summary counted its speakers from 1: worth a look.
                assigneeCheck = offset !== 0;
            }
        } else if (item.assignee && view) {
            const person = matchPerson(view, item.assignee, language);
            if (person) {
                assigneePersonId = person.id;
                assigneeCheck = heardIsFirstNameOnly(item.assignee, {
                    name: person.name,
                    aliases: person.aliases,
                });
            } else {
                assigneeHint = item.assignee;
            }
        }
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
                ticked: shouldPreselectTaskOutcome(
                    "match",
                    1,
                    located.evidenceProvenance,
                ),
            });
            continue;
        }
        proposedUpdates.push({
            taskId,
            kind: update.kind,
            dueDate: update.due?.date ?? null,
            duePhrase: update.due?.phrase ?? null,
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
): Pick<
    ProposedTask,
    "evidenceStartMs" | "evidenceText" | "evidenceProvenance" | "quotedAt"
> {
    const readable = mail.segments.filter(
        (segment) => !segment.knownItemId && segment.role !== "disclaimer",
    );
    const range = locateTextQuote(readable, quote);
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
