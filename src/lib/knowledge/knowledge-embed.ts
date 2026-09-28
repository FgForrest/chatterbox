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

import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import {
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

/**
 * Bring `scope`'s vectors up to date in the client's generation: embed
 * what changed, drop what is gone, and once nothing is missing make the
 * generation the one searched and drop the others. Throws
 * `EmbeddingUnavailable` when the service fails; what was stored stays,
 * and the generation searched stays the old one.
 */
export async function embedScope(
    scope: string,
    client: EmbeddingClient,
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

    const vectors = await client.embed(stale.map((item) => item.text));
    let removed = 0;
    await db.transaction(async (tx) => {
        for (const [index, item] of stale.entries()) {
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
        }
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
                embeddedAt: scopeGeneration,
                vectorVersion: 1,
            })
            .onConflictDoUpdate({
                target: knowledgeVectorState.userId,
                set: {
                    activeGeneration: generation,
                    embeddedAt: scopeGeneration,
                    vectorVersion: sql`${knowledgeVectorState.vectorVersion} + 1`,
                    updatedAt: new Date(),
                },
            });
    });
    return { embedded: stale.length, removed, active: generation };
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
        const result = await embedScope(context.userId, client);
        return { ...result };
    },
};

/** Queue a run for every scope whose vectors are behind. */
export async function seedKnowledgeEmbedJobs(): Promise<number> {
    const client = embeddingClient();
    if (!client) return 0;
    const generation = vectorGenerationFor(client.model);
    const behind = await db
        .select({ userId: knowledgeScopeGenerations.userId })
        .from(knowledgeScopeGenerations)
        .leftJoin(
            knowledgeVectorState,
            eq(knowledgeVectorState.userId, knowledgeScopeGenerations.userId),
        )
        .where(
            or(
                isNull(knowledgeVectorState.userId),
                sql`${knowledgeVectorState.embeddedAt} is distinct from ${knowledgeScopeGenerations.generation}`,
                sql`${knowledgeVectorState.activeGeneration} is distinct from ${generation}`,
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
