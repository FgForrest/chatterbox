/**
 * Running a Learn run (job kind `learn.run`): read the transcript the run
 * was started on, find what it says through the run's scopes, validate
 * the answer against the run, and store what holds as review items for a
 * person to decide on. Nothing here changes knowledge: the review does.
 *
 * The run goes nowhere when it no longer should: a changed transcript
 * supersedes it; a recording that was shared, withdrawn or deleted since,
 * so that the actor may no longer change it in the run's view, cancels it.
 * Both are checked again under the recording lock where the items are
 * written. The provider is the actor's, who pays; path 2 (no tools) until
 * the bridge path lands (Task 3.6).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import {
    apiCredentials,
    knowledgeScopeGenerations,
    knowledgeVocabularyVersion,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import {
    enhancementChatModel,
    pickEnhancementCredential,
} from "@/lib/ai/enhancement-provider";
import { decrypt } from "@/lib/encryption";
import { encryptJsonField } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { retryWithBackoff } from "@/lib/jobs/backoff";
import { isRetryableError } from "@/lib/jobs/retryable";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { listCorrections } from "@/lib/knowledge/corrections";
import { nodeKey } from "@/lib/knowledge/fact-rules";
import { objectKeyOf } from "@/lib/knowledge/facts";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { readableScopes } from "@/lib/knowledge/scope";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { isFinalLearnError } from "@/lib/learn/errors";
import {
    LEARN_JOB_KIND,
    LEARN_MAX_ATTEMPTS,
    type LearnJobPayload,
    parseLearnJobPayload,
} from "@/lib/learn/learn-job";
import type { LearnObject } from "@/lib/learn/output";
import { chooseLearnPath } from "@/lib/learn/provider";
import {
    type LearnChat,
    type LearnRelationChoice,
    runFallbackPass,
} from "@/lib/learn/run-fallback";
import { findEntities, type LearnToolContext } from "@/lib/learn/tools";
import {
    currentFactKey,
    factKey,
    heardAsKey,
    type LearnRunFrame,
    type ReviewCandidate,
    validateLearnOutput,
} from "@/lib/learn/validate";
import { contentWriterRefusal, sharingOrgUserId } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

const FINGERPRINT_DOMAIN = "learn-fingerprint";
/** Knowledge lookups one run may make. */
const TOOL_BUDGET = 60;
const CALL_RETRY_ATTEMPTS = 3;
/**
 * How often a run validates again when what it validated against changed
 * before the items were written; the last time, it writes without
 * pre-ticking anything.
 */
const FENCE_ATTEMPTS = 3;

/** How a review item's fingerprint is stored: a keyed HMAC. */
export function learnFingerprintHmac(fingerprint: string): string {
    return domainLookupHash(FINGERPRINT_DOMAIN, fingerprint);
}

type RunRow = typeof learnRuns.$inferSelect;
type Outcome =
    | "ready"
    | "finished"
    | "superseded"
    | "cancelled"
    | "failed"
    | "queued";

/**
 * Leave the run this attempt claimed: only while it is still `running`, so
 * a status someone else set meanwhile (superseded by a rewrite, cancelled,
 * or claimed again by a later attempt) is never overwritten.
 */
async function setStatus(
    runId: string,
    status: Outcome,
    extra: Partial<typeof learnRuns.$inferInsert> = {},
): Promise<void> {
    await db
        .update(learnRuns)
        .set({ status, updatedAt: new Date(), ...extra })
        .where(and(eq(learnRuns.id, runId), eq(learnRuns.status, "running")));
}

/** The actor's chat provider, as the Learn pass talks to it. */
async function chatFor(
    actorUserId: string,
    signal: AbortSignal,
): Promise<{ chat: LearnChat; provider: string; model: string }> {
    const configured = await db
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, actorUserId));
    const credentials = pickEnhancementCredential(configured);
    if (!credentials) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            "No AI provider configured",
            400,
        );
    }
    const openai = new OpenAI({
        apiKey: decrypt(credentials.apiKey),
        baseURL: credentials.baseUrl || undefined,
    });
    const model = enhancementChatModel(credentials);
    return {
        provider: credentials.provider,
        model,
        chat: {
            complete: (messages, maxTokens) =>
                retryWithBackoff({
                    attempts: CALL_RETRY_ATTEMPTS,
                    baseMs: 1_500,
                    maxMs: 15_000,
                    jitter: 0.5,
                    isRetryable: isRetryableError,
                    run: async () => {
                        signal.throwIfAborted();
                        const response = await openai.chat.completions.create(
                            buildChatCompletionParams({
                                model,
                                messages,
                                temperature: 0.1,
                                maxTokens,
                            }),
                            { signal },
                        );
                        return (
                            response.choices[0]?.message?.content?.trim() || ""
                        );
                    },
                }),
        },
    };
}

/**
 * Whether the actor may still change the recording in the run's view: the
 * writer rule, and the view the run was started in. `orgUserId` is
 * resolved by the caller, outside any transaction (`sharingOrgUserId`).
 */
async function mayStillRun(
    run: RunRow,
    orgUserId: string | null,
    executor?: Parameters<typeof contentWriterRefusal>[0],
): Promise<boolean> {
    if (!run.actorUserId) return false;
    const refusal = await contentWriterRefusal(executor, {
        recordingId: run.recordingId,
        ownerUserId: run.userId,
        actorUserId: run.actorUserId,
        orgUserId,
    });
    if (refusal) return false;
    return run.view === "private"
        ? run.actorUserId === run.userId
        : orgUserId !== null && run.actorUserId === orgUserId;
}

type Executor = Pick<typeof db, "select">;

/**
 * What a validation depended on, as one comparable value: the generations
 * of the scopes the run reads, the vocabulary's version, the answers given
 * on the transcript's speakers and the recording's dismissals. Read before
 * the frame, and again under the locks the items are written under: when
 * the two differ, the frame may be stale (an entity deleted, an alias taken
 * back, a speaker answered) and the run validates again.
 */
async function fenceOf(
    executor: Executor,
    run: RunRow,
    orgUserId: string | null,
    { lock = false }: { lock?: boolean } = {},
): Promise<string> {
    const scopes = readableScopes(
        {
            kind: "recording",
            ownerUserId: run.userId,
            shared: run.view === "org",
        },
        orgUserId,
    );
    // Under the write, the counters are held for share: a change that has
    // bumped them and not yet committed is waited for, and then seen. In
    // the order writers take them (the vocabulary's version first, the
    // scope generations last), so the two never wait on each other.
    const versioned = executor
        .select({ version: knowledgeVocabularyVersion.version })
        .from(knowledgeVocabularyVersion)
        .where(eq(knowledgeVocabularyVersion.id, 1));
    const [vocabulary] = await (lock ? versioned.for("share") : versioned);
    const generations = new Map(scopes.map((scope) => [scope, 0]));
    const counted = executor
        .select({
            userId: knowledgeScopeGenerations.userId,
            generation: knowledgeScopeGenerations.generation,
        })
        .from(knowledgeScopeGenerations)
        .where(inArray(knowledgeScopeGenerations.userId, scopes))
        // The order `bumpScopeInTx` sorts in (code units), whatever the
        // database's collation.
        .orderBy(sql`${knowledgeScopeGenerations.userId} collate "C"`);
    for (const row of await (lock ? counted.for("share") : counted)) {
        generations.set(row.userId, row.generation);
    }
    const answered = await executor
        .select({
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            markedUnknown: transcriptSpeakers.markedUnknown,
        })
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.transcriptionId, run.transcriptionId))
        .orderBy(asc(transcriptSpeakers.label));
    const dismissed = await executor
        .select({ hmac: learnDismissals.fingerprintHmac })
        .from(learnDismissals)
        .where(
            and(
                eq(learnDismissals.recordingId, run.recordingId),
                eq(learnDismissals.userId, run.scopeUserId),
            ),
        )
        .orderBy(asc(learnDismissals.fingerprintHmac));
    return JSON.stringify([
        [...generations.entries()].sort(),
        vocabulary?.version ?? 0,
        answered,
        dismissed.map((row) => row.hmac),
    ]);
}

/** Everything the validation needs to know of the run's scopes, frozen now. */
async function frameFor(
    run: RunRow,
    transcript: {
        revision: number;
        turns: NonNullable<ReturnType<typeof readTranscriptTurns>>;
        language: string | null;
        provider: string | null;
    },
): Promise<LearnRunFrame> {
    const shared = run.view === "org";
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: run.userId,
        shared,
    });
    const vocabulary = await vocabularyVisibleTo(run.scopeUserId, {
        sharedOnly: shared,
    });
    const answered = await db
        .select({
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            markedUnknown: transcriptSpeakers.markedUnknown,
        })
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.transcriptionId, run.transcriptionId));
    const dismissed = await db
        .select({ hmac: learnDismissals.fingerprintHmac })
        .from(learnDismissals)
        .where(
            and(
                eq(learnDismissals.recordingId, run.recordingId),
                eq(learnDismissals.userId, run.scopeUserId),
            ),
        );
    const people = new Map<string, { name: string }>();
    const entities = new Map<string, { typeKey: string; name: string }>();
    const confirmedHeardAs = new Set<string>();
    for (const item of view.items) {
        if (item.kind === "person") people.set(item.id, { name: item.name });
        else entities.set(item.id, { typeKey: item.typeKey, name: item.name });
        for (const name of item.names) {
            if (name.kind !== "heard_as") continue;
            confirmedHeardAs.add(
                heardAsKey(
                    name.target,
                    name.text,
                    name.language,
                    name.provider,
                ),
            );
        }
    }
    const literalKey = (literal: string) => objectKeyOf({ literal });
    // The run writes its own scope: the owner's on a private recording,
    // the Organization's on a shared one.
    const ownScope = shared ? "org" : "personal";
    const knownFacts = new Map<string, string>();
    const foreignFacts = new Set<string>();
    const currentFacts = new Map<
        string,
        { factId: string; object: LearnObject }
    >();
    for (const fact of view.facts) {
        const key = factKey(
            nodeKey(fact.subject),
            fact.relationKey,
            "literal" in fact.object
                ? literalKey(fact.object.literal)
                : nodeKey(fact.object),
        );
        if (fact.scope !== ownScope) {
            foreignFacts.add(key);
            continue;
        }
        knownFacts.set(key, fact.id);
        currentFacts.set(
            currentFactKey(nodeKey(fact.subject), fact.relationKey),
            { factId: fact.id, object: fact.object },
        );
    }
    return {
        revision: run.transcriptRevision,
        currentRevision: transcript.revision,
        transcriptKey: `${run.transcriptionId}@${run.transcriptRevision}`,
        turns: transcript.turns,
        language: transcript.language,
        provider: transcript.provider,
        manual: run.trigger === "manual",
        people,
        entities,
        relations: new Map(
            vocabulary.relationTypes
                .filter((relation) => !relation.adoptedAsKey)
                .map((relation) => [relation.key, relation]),
        ),
        answeredLabels: new Map(
            answered
                .filter(
                    (row) => row.status === "confirmed" || row.markedUnknown,
                )
                .map((row) => [
                    row.label,
                    row.markedUnknown ? null : row.personId,
                ]),
        ),
        confirmedHeardAs,
        knownFacts,
        foreignFacts,
        currentFacts,
        // The words that already carry a confirmed correction, as everyone
        // reading the transcript in its view sees them.
        corrected: (await listCorrections(run.userId, run.transcriptionId)).map(
            ({ turnIndex, charStart, charEnd }) => ({
                turnIndex,
                charStart,
                charEnd,
            }),
        ),
        dismissed: new Set(dismissed.map((row) => row.hmac)),
        fingerprintKey: learnFingerprintHmac,
        literalKey,
    };
}

function counts(
    items: readonly ReviewCandidate[],
    extra: Record<string, number>,
): Record<string, number> {
    const stats: Record<string, number> = { ...extra, items: items.length };
    for (const item of items) {
        stats[`items_${item.kind}`] = (stats[`items_${item.kind}`] ?? 0) + 1;
    }
    return stats;
}

export const learnJobHandler: JobHandler<LearnJobPayload> = {
    kind: LEARN_JOB_KIND,
    // One at a time: runs go to the same providers as summaries.
    concurrency: 1,
    maxAttempts: LEARN_MAX_ATTEMPTS,
    timeoutMs: 20 * 60 * 1000,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseLearnJobPayload,

    async run({
        payload,
        attempt,
        maxAttempts,
        signal,
        reportProgress,
    }): Promise<JobResult> {
        const [run] = await db
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.id, payload.runId));
        if (!run) return { skipped: "gone" };
        if (run.status !== "queued" && run.status !== "running") {
            return { skipped: run.status };
        }
        const claimed = await db
            .update(learnRuns)
            .set({
                status: "running",
                startedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(learnRuns.id, run.id),
                    inArray(learnRuns.status, ["queued", "running"]),
                ),
            )
            .returning({ id: learnRuns.id });
        if (claimed.length === 0) return { skipped: "claimed" };

        try {
            const [transcript] = await db
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.id, run.transcriptionId));
            if (!transcript) {
                await setStatus(run.id, "cancelled");
                return { skipped: "gone" };
            }
            if (transcript.revision !== run.transcriptRevision) {
                await setStatus(run.id, "superseded");
                return { skipped: "superseded" };
            }
            const orgUserId = await sharingOrgUserId();
            if (!(await mayStillRun(run, orgUserId))) {
                await setStatus(run.id, "cancelled");
                return { skipped: "not allowed" };
            }
            const turns = readTranscriptTurns(transcript);
            if (!turns?.length) {
                await setStatus(run.id, "cancelled");
                return { skipped: "untimed" };
            }

            const shared = run.view === "org";
            const tools: LearnToolContext = {
                read: { kind: "recording", ownerUserId: run.userId, shared },
                budget: { remaining: TOOL_BUDGET },
            };
            const vocabulary = await vocabularyVisibleTo(run.scopeUserId, {
                sharedOnly: shared,
            });
            const relations: LearnRelationChoice[] =
                vocabulary.relationTypes.filter(
                    (relation) => !relation.adoptedAsKey,
                );
            const frameBefore = await frameFor(run, {
                revision: transcript.revision,
                turns,
                language: transcript.detectedLanguage,
                provider: transcript.provider,
            });
            const labels = [...new Set(turns.map((turn) => turn.speaker))];
            const { chat, provider, model } = await chatFor(
                run.actorUserId ?? "",
                signal,
            );
            // Path 1 (the bridge, with tools) lands with Task 3.6; until
            // then every run takes the fallback, and says so.
            const path = chooseLearnPath(
                { provider },
                { mcpUrl: env.LEARN_MCP_URL },
            );
            reportProgress({ phase: "reading" });
            const pass = await runFallbackPass({
                chat,
                lookup: {
                    findEntities: (query) => findEntities(tools, query),
                },
                turns,
                language: transcript.detectedLanguage,
                relations,
                unnamedLabels: labels.filter(
                    (label) => !frameBefore.answeredLabels.has(label),
                ),
                signal,
            });
            reportProgress({ phase: "checking" });

            // Validated against the knowledge as it is now; written under the
            // recording and transcript locks, with the revision, the writer
            // rule and the run's own status checked once more, and validated
            // again when what the validation read moved meanwhile.
            const baseStats = {
                calls: pass.calls,
                lookups: pass.lookups,
                windows: pass.windows,
                repairs: pass.repairs,
            };
            for (let fenceAttempt = 1; ; fenceAttempt++) {
                const lastAttempt = fenceAttempt >= FENCE_ATTEMPTS;
                const fence = await fenceOf(db, run, orgUserId);
                const frame = await frameFor(run, {
                    revision: transcript.revision,
                    turns,
                    language: transcript.detectedLanguage,
                    provider: transcript.provider,
                });
                const validated = validateLearnOutput(pass.output, frame);
                const items: ReviewCandidate[] = lastAttempt
                    ? validated.items.map(
                          (item) =>
                              ({
                                  ...item,
                                  preTicked: false,
                              }) as ReviewCandidate,
                      )
                    : validated.items;
                const stats = counts(items, {
                    ...baseStats,
                    ...(fenceAttempt > 1
                        ? { fence_retries: fenceAttempt - 1 }
                        : {}),
                    ...Object.fromEntries(
                        Object.entries(validated.dropped).map(([reason, n]) => [
                            `dropped_${reason}`,
                            n ?? 0,
                        ]),
                    ),
                });
                const outcome = await db.transaction(async (tx) => {
                    await tx
                        .select({ id: recordings.id })
                        .from(recordings)
                        .where(eq(recordings.id, run.recordingId))
                        .for("share");
                    // Speaker answers are written under the transcript held
                    // for update: holding it for share keeps them still.
                    const [current] = await tx
                        .select({ revision: transcriptions.revision })
                        .from(transcriptions)
                        .where(eq(transcriptions.id, run.transcriptionId))
                        .for("share");
                    const [still] = await tx
                        .select({ status: learnRuns.status })
                        .from(learnRuns)
                        .where(eq(learnRuns.id, run.id))
                        .for("update");
                    if (!current || still?.status !== "running") {
                        return { status: "cancelled" as const, items: 0 };
                    }
                    const finish = (
                        status:
                            | "ready"
                            | "finished"
                            | "superseded"
                            | "cancelled",
                    ) =>
                        tx
                            .update(learnRuns)
                            .set({
                                status,
                                path,
                                provider,
                                model,
                                // Merged: the MCP route counts its tool
                                // calls on the same row.
                                stats: sql`coalesce(${learnRuns.stats}, '{}'::jsonb) || ${JSON.stringify(stats)}::jsonb`,
                                finishedAt:
                                    status === "ready" ? null : new Date(),
                                updatedAt: new Date(),
                            })
                            .where(eq(learnRuns.id, run.id));
                    if (
                        validated.superseded ||
                        current.revision !== run.transcriptRevision
                    ) {
                        await finish("superseded");
                        return { status: "superseded" as const, items: 0 };
                    }
                    if (!(await mayStillRun(run, orgUserId, tx))) {
                        await finish("cancelled");
                        return { status: "cancelled" as const, items: 0 };
                    }
                    if (
                        !lastAttempt &&
                        (await fenceOf(tx, run, orgUserId, { lock: true })) !==
                            fence
                    ) {
                        return { status: "stale" as const, items: 0 };
                    }
                    if (items.length > 0) {
                        await tx.insert(learnReviewItems).values(
                            items.map((item) => ({
                                runId: run.id,
                                userId: run.scopeUserId,
                                kind: item.kind,
                                fingerprintHmac: learnFingerprintHmac(
                                    item.fingerprint,
                                ),
                                payload: encryptJsonField(item.payload),
                                preTicked: item.preTicked,
                                dependsOnLabel:
                                    "dependsOnLabel" in item
                                        ? (item.dependsOnLabel ?? null)
                                        : null,
                            })),
                        );
                    }
                    // An empty run says "nothing new found" and counts as
                    // finished.
                    const status =
                        items.length > 0
                            ? ("ready" as const)
                            : ("finished" as const);
                    await finish(status);
                    return { status, items: items.length };
                });
                if (outcome.status === "stale") continue;
                return { status: outcome.status, items: outcome.items };
            }
        } catch (caught) {
            // Final for Learn (lookups spent, no usable answer): no retry.
            const error = isFinalLearnError(caught)
                ? new AppError(
                      ErrorCode.AI_PROVIDER_API_ERROR,
                      caught instanceof Error ? caught.message : "Learn failed",
                      502,
                  )
                : caught;
            // Retried by the queue when worth it: the run waits for it.
            const retrying = attempt < maxAttempts && isRetryableError(error);
            await setStatus(
                run.id,
                retrying ? "queued" : "failed",
                retrying
                    ? {}
                    : {
                          errorCode:
                              error instanceof AppError
                                  ? error.code
                                  : ErrorCode.INTERNAL_ERROR,
                          finishedAt: new Date(),
                      },
            );
            throw error;
        }
    },
};
