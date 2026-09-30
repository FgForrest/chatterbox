/**
 * Keeping a scope's vectors up to date (job kind `knowledge.embed`).
 *
 * What is embedded is text rendered from knowledge, never names alone and
 * never transcripts: an entity with a description (its name, type and
 * description; for a term, its definition), and a current fact ("subject
 * relation object"). A vector belongs to a generation, the model plus
 * `RENDER_VERSION`; a new one is built beside the old, which stays
 * searchable until the new is complete.
 *
 * A seeder in the process queues a run for every scope whose knowledge
 * moved past what its vectors were made from, or whose vectors are of
 * another generation. A run moves `vectorVersion`, not the scope
 * generation, so it never queues itself again.
 */

import {
    and,
    eq,
    gt,
    inArray,
    isNull,
    ne,
    notExists,
    notInArray,
    or,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import {
    asyncJobs,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeScopeGenerations,
    knowledgeVectorState,
    knowledgeVectors,
    people,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { nudge } from "@/lib/jobs/nudge";
import type { JobHandler } from "@/lib/jobs/types";
import {
    type EmbeddingClient,
    embeddingClient,
} from "@/lib/knowledge/embeddings";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { readScopeGenerations } from "@/lib/knowledge/scope-generation";
import { encodeVector } from "@/lib/knowledge/vector-search";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";

export const KNOWLEDGE_EMBED_JOB_KIND = "knowledge.embed";
/** How knowledge is rendered for embedding; a change builds a new generation. */
export const RENDER_VERSION = 1;
const INPUT_DOMAIN = "vector-input";

export function vectorGenerationFor(model: string): string {
    return `${model}#r${RENDER_VERSION}`;
}

export function renderEntity(entity: {
    name: string;
    typeLabel: string;
    description: string;
}): string {
    return `${entity.name} (${entity.typeLabel}): ${entity.description}`;
}

export function renderFact(fact: {
    subject: string;
    relation: string;
    object: string;
}): string {
    return `${fact.subject} ${fact.relation} ${fact.object}`;
}

interface Rendered {
    entityId: string | null;
    factId: string | null;
    text: string;
}

/** The texts a scope's knowledge renders to now. */
async function renderScope(scope: string): Promise<Rendered[]> {
    const vocabulary = await vocabularyVisibleTo(scope);
    const typeLabels = new Map(
        vocabulary.entityTypes.map((type) => [type.key, type.label]),
    );
    const relationLabels = new Map(
        vocabulary.relationTypes.map((relation) => [
            relation.key,
            relation.label,
        ]),
    );
    const entities = await db
        .select({
            id: knowledgeEntities.id,
            typeKey: knowledgeEntities.typeKey,
            name: knowledgeEntities.name,
            description: knowledgeEntities.description,
        })
        .from(knowledgeEntities)
        .where(
            and(
                eq(knowledgeEntities.userId, scope),
                isNull(knowledgeEntities.mergedIntoId),
                sql`${knowledgeEntities.description} is not null`,
            ),
        );
    const facts = await db
        .select({
            id: knowledgeFacts.id,
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            relationKey: knowledgeFacts.relationKey,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
            objectLiteral: knowledgeFacts.objectLiteral,
        })
        .from(knowledgeFacts)
        .where(
            and(
                eq(knowledgeFacts.userId, scope),
                isNull(knowledgeFacts.replacedByFactId),
                or(
                    eq(knowledgeFacts.origin, "manual"),
                    sql`exists (${db
                        .select({ id: knowledgeFactEvidence.id })
                        .from(knowledgeFactEvidence)
                        .where(
                            and(
                                eq(
                                    knowledgeFactEvidence.factId,
                                    knowledgeFacts.id,
                                ),
                                eq(knowledgeFactEvidence.status, "supported"),
                            ),
                        )})`,
                ),
            ),
        );

    // The names facts refer to, in this scope or the Organization's.
    const personIds = facts.flatMap((fact) =>
        [fact.subjectPersonId, fact.objectPersonId].filter((id): id is string =>
            Boolean(id),
        ),
    );
    const entityIds = facts.flatMap((fact) =>
        [fact.subjectEntityId, fact.objectEntityId].filter((id): id is string =>
            Boolean(id),
        ),
    );
    const [personRows, entityRows] = await Promise.all([
        personIds.length > 0
            ? db
                  .select({ id: people.id, name: people.displayName })
                  .from(people)
                  .where(inArray(people.id, personIds))
            : [],
        entityIds.length > 0
            ? db
                  .select({
                      id: knowledgeEntities.id,
                      name: knowledgeEntities.name,
                  })
                  .from(knowledgeEntities)
                  .where(inArray(knowledgeEntities.id, entityIds))
            : [],
    ]);
    const names = new Map(
        [...personRows, ...entityRows].map((row) => [
            row.id,
            decryptText(row.name),
        ]),
    );

    const rendered: Rendered[] = entities.map((entity) => ({
        entityId: entity.id,
        factId: null,
        text: renderEntity({
            name: decryptText(entity.name),
            typeLabel: typeLabels.get(entity.typeKey) ?? entity.typeKey,
            description: decryptText(entity.description ?? ""),
        }),
    }));
    for (const fact of facts) {
        const subject =
            names.get(fact.subjectPersonId ?? fact.subjectEntityId ?? "") ?? "";
        const object = fact.objectLiteral
            ? decryptText(fact.objectLiteral)
            : (names.get(fact.objectPersonId ?? fact.objectEntityId ?? "") ??
              "");
        if (!subject || !object) continue;
        rendered.push({
            entityId: null,
            factId: fact.id,
            text: renderFact({
                subject,
                relation:
                    relationLabels.get(fact.relationKey) ?? fact.relationKey,
                object,
            }),
        });
    }
    return rendered;
}

export interface EmbedResult {
    embedded: number;
    removed: number;
    active: string | null;
}

/** How many items are embedded and written at a time. */
const CHUNK_SIZE = 64;

/**
 * Write the vectors of the items in `chunk` that still exist in `scope`,
 * in one transaction. Their rows are held (FOR KEY SHARE) while it
 * writes, so what is written cannot lose its item before it commits; an
 * item gone since the texts were rendered is skipped, and the scope
 * generation it moved queues the next run. An item a deletion holds is
 * skipped too, never waited on: the embedder would otherwise lock entities
 * before facts, a deletion facts before entities, and one would be
 * aborted. Returns how many were written.
 */
async function writeChunk(
    scope: string,
    generation: string,
    chunk: readonly (Rendered & { inputHmac: string })[],
    vectors: readonly Float32Array[],
): Promise<number> {
    return db.transaction(async (tx) => {
        const entityIds = chunk.flatMap((item) =>
            item.entityId ? [item.entityId] : [],
        );
        const factIds = chunk.flatMap((item) =>
            item.factId ? [item.factId] : [],
        );
        const present = new Set<string>();
        if (entityIds.length > 0) {
            const rows = await tx
                .select({ id: knowledgeEntities.id })
                .from(knowledgeEntities)
                .where(
                    and(
                        inArray(knowledgeEntities.id, entityIds),
                        eq(knowledgeEntities.userId, scope),
                    ),
                )
                .for("key share", { skipLocked: true });
            for (const row of rows) present.add(row.id);
        }
        if (factIds.length > 0) {
            const rows = await tx
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(
                    and(
                        inArray(knowledgeFacts.id, factIds),
                        eq(knowledgeFacts.userId, scope),
                    ),
                )
                .for("key share", { skipLocked: true });
            for (const row of rows) present.add(row.id);
        }
        let written = 0;
        for (const [index, item] of chunk.entries()) {
            if (!present.has(item.entityId ?? item.factId ?? "")) continue;
            const vector = vectors[index] as Float32Array;
            await tx
                .insert(knowledgeVectors)
                .values({
                    userId: scope,
                    entityId: item.entityId,
                    factId: item.factId,
                    vectorGeneration: generation,
                    dim: vector.length,
                    vector: encryptText(encodeVector(vector)),
                    inputHmac: item.inputHmac,
                })
                .onConflictDoUpdate({
                    target: [
                        knowledgeVectors.userId,
                        knowledgeVectors.entityId,
                        knowledgeVectors.factId,
                        knowledgeVectors.vectorGeneration,
                    ],
                    set: {
                        dim: vector.length,
                        vector: encryptText(encodeVector(vector)),
                        inputHmac: item.inputHmac,
                        createdAt: new Date(),
                    },
                });
            written++;
        }
        return written;
    });
}

/**
 * Bring `scope`'s vectors up to date in the client's generation: embed
 * what changed, a chunk at a time, each written in its own transaction;
 * then drop what is gone, make the generation the one searched and drop
 * the others. Throws `EmbeddingUnavailable` when the service fails, and
 * the signal's reason when cancelled (checked between chunks): the
 * chunks written stay, and the generation searched stays the old one.
 */
export async function embedScope(
    scope: string,
    client: EmbeddingClient,
    {
        signal,
        chunkSize = CHUNK_SIZE,
    }: { signal?: AbortSignal; chunkSize?: number } = {},
): Promise<EmbedResult> {
    const generation = vectorGenerationFor(client.model);
    // Read before rendering: what the vectors are made from is at least
    // this new.
    const scopeGeneration =
        (await readScopeGenerations(db, [scope])).get(scope) ?? 0;
    const rendered = await renderScope(scope);
    const existing = await db
        .select({
            entityId: knowledgeVectors.entityId,
            factId: knowledgeVectors.factId,
            inputHmac: knowledgeVectors.inputHmac,
        })
        .from(knowledgeVectors)
        .where(
            and(
                eq(knowledgeVectors.userId, scope),
                eq(knowledgeVectors.vectorGeneration, generation),
            ),
        );
    const itemKey = (item: {
        entityId: string | null;
        factId: string | null;
    }) => (item.entityId ? `e:${item.entityId}` : `f:${item.factId}`);
    const held = new Map(existing.map((row) => [itemKey(row), row.inputHmac]));
    const stale = rendered
        .map((item) => ({
            ...item,
            inputHmac: domainLookupHash(INPUT_DOMAIN, item.text),
        }))
        .filter((item) => held.get(itemKey(item)) !== item.inputHmac);

    let embedded = 0;
    for (let start = 0; start < stale.length; start += chunkSize) {
        signal?.throwIfAborted();
        const chunk = stale.slice(start, start + chunkSize);
        const vectors = await client.embed(
            chunk.map((item) => item.text),
            { signal },
        );
        embedded += await writeChunk(scope, generation, chunk, vectors);
    }
    signal?.throwIfAborted();

    // An item skipped (gone, or held by a deletion that may yet roll back)
    // leaves the scope marked behind, so the seeder runs it again.
    const caughtUp = embedded === stale.length ? scopeGeneration : null;
    let removed = 0;
    await db.transaction(async (tx) => {
        // What no longer renders (gone, replaced, its description cleared).
        const current = rendered.map((item) => item.entityId ?? item.factId);
        const gone = await tx
            .delete(knowledgeVectors)
            .where(
                and(
                    eq(knowledgeVectors.userId, scope),
                    current.length > 0
                        ? and(
                              or(
                                  isNull(knowledgeVectors.entityId),
                                  notInArray(
                                      knowledgeVectors.entityId,
                                      current.filter((id): id is string =>
                                          Boolean(id),
                                      ),
                                  ),
                              ),
                              or(
                                  isNull(knowledgeVectors.factId),
                                  notInArray(
                                      knowledgeVectors.factId,
                                      current.filter((id): id is string =>
                                          Boolean(id),
                                      ),
                                  ),
                              ),
                          )
                        : undefined,
                    eq(knowledgeVectors.vectorGeneration, generation),
                ),
            )
            .returning({ id: knowledgeVectors.id });
        removed = gone.length;
        // Complete: this generation is the one searched, the others go.
        await tx
            .delete(knowledgeVectors)
            .where(
                and(
                    eq(knowledgeVectors.userId, scope),
                    ne(knowledgeVectors.vectorGeneration, generation),
                ),
            );
        await tx
            .insert(knowledgeVectorState)
            .values({
                userId: scope,
                activeGeneration: generation,
                embeddedAt: caughtUp,
                vectorVersion: 1,
            })
            .onConflictDoUpdate({
                target: knowledgeVectorState.userId,
                set: {
                    activeGeneration: generation,
                    embeddedAt: caughtUp,
                    vectorVersion: sql`${knowledgeVectorState.vectorVersion} + 1`,
                    updatedAt: new Date(),
                },
            });
    });
    return { embedded, removed, active: generation };
}

export const knowledgeEmbedJobHandler: JobHandler<Record<string, never>> = {
    kind: KNOWLEDGE_EMBED_JOB_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 10 * 60 * 1000,
    parsePayload: () => ({}),
    run: async (context) => {
        const client = embeddingClient();
        if (!client) return { skipped: "unavailable" };
        const result = await embedScope(context.userId, client, {
            signal: context.signal,
        });
        return { ...result };
    },
};

/** A scope whose run failed waits this long before it is queued again. */
const FAILED_RUN_PAUSE_MS = 30 * 60 * 1000;

/**
 * Queue a run for every scope whose vectors are behind. Nothing while the
 * service is paused (its breaker is open), and not a scope whose last run
 * failed less than half an hour ago: its attempts are spent, and asking
 * every minute would only fail again.
 */
export async function seedKnowledgeEmbedJobs({
    client = embeddingClient(),
}: {
    client?: EmbeddingClient | null;
} = {}): Promise<number> {
    if (!client?.available) return 0;
    const generation = vectorGenerationFor(client.model);
    const behind = await db
        .select({ userId: knowledgeScopeGenerations.userId })
        .from(knowledgeScopeGenerations)
        .leftJoin(
            knowledgeVectorState,
            eq(knowledgeVectorState.userId, knowledgeScopeGenerations.userId),
        )
        .where(
            and(
                or(
                    isNull(knowledgeVectorState.userId),
                    sql`${knowledgeVectorState.embeddedAt} is distinct from ${knowledgeScopeGenerations.generation}`,
                    sql`${knowledgeVectorState.activeGeneration} is distinct from ${generation}`,
                ),
                notExists(
                    db
                        .select({ id: asyncJobs.id })
                        .from(asyncJobs)
                        .where(
                            and(
                                eq(asyncJobs.kind, KNOWLEDGE_EMBED_JOB_KIND),
                                eq(
                                    asyncJobs.subjectId,
                                    sql`'knowledge:' || ${knowledgeScopeGenerations.userId}`,
                                ),
                                eq(asyncJobs.status, "failed"),
                                gt(
                                    asyncJobs.completedAt,
                                    new Date(Date.now() - FAILED_RUN_PAUSE_MS),
                                ),
                            ),
                        ),
                ),
            ),
        )
        .limit(200);
    let queued = 0;
    for (const { userId } of behind) {
        const result = await enqueueJob({
            userId,
            kind: KNOWLEDGE_EMBED_JOB_KIND,
            subjectId: `knowledge:${userId}`,
            maxAttempts: knowledgeEmbedJobHandler.maxAttempts,
            payload: {},
        });
        if (result.created) queued++;
    }
    if (queued > 0) nudge();
    return queued;
}

let seeding = false;

/** Check for scopes whose vectors are behind every minute. */
export function startKnowledgeEmbedSeeder(): void {
    if (seeding || !embeddingClient()) return;
    seeding = true;
    setInterval(() => {
        void seedKnowledgeEmbedJobs().catch((error) => {
            console.error("[knowledge] could not queue embedding runs:", error);
        });
    }, 60_000).unref();
}
