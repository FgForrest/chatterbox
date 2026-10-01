/**
 * The database side of the knowledge memory store: what a scope's
 * knowledge is loaded from, the store every request of this process
 * shares, the listener that only hears of changes sooner, and the view a
 * reader gets, merged from the scopes it may read.
 */

import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";
import { db, sqlClient } from "@/db";
import {
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityNotes,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeVectorState,
    knowledgeVectors,
    people,
    personNotes,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import {
    EmbeddingUnavailable,
    embeddingClient,
} from "@/lib/knowledge/embeddings";
import {
    KnowledgeMemoryStore,
    type KnownFact,
    type KnownItem,
    type KnownName,
    type LoadedScope,
} from "@/lib/knowledge/memory-store";
import type {
    NameIndex,
    NameMatch,
    WordStemmer,
} from "@/lib/knowledge/name-match";
import { type ReadContext, readableScopes } from "@/lib/knowledge/scope";
import {
    KNOWLEDGE_CHANNEL,
    readScopeGenerations,
} from "@/lib/knowledge/scope-generation";
import { stemmingLanguage, stemVariants } from "@/lib/knowledge/stemming";
import {
    buildMatrix,
    decodeVector,
    topK,
    type VectorHit,
    type VectorMatrix,
} from "@/lib/knowledge/vector-search";
import { getOrgUserId } from "@/lib/org/config";

function nodeOf(
    personId: string | null,
    entityId: string | null,
): KnowledgeTarget {
    return personId ? { personId } : { entityId: entityId ?? "" };
}

/**
 * What `scope` knows, decrypted: its own people and entities, its names
 * and notes (also on the Organization's), and its facts that are current
 * and shown (entered by hand, or with some supported evidence).
 */
export async function loadScopeKnowledge(scope: string): Promise<LoadedScope> {
    const [
        personRows,
        entityRows,
        aliasRows,
        personNoteRows,
        entityNoteRows,
        factRows,
    ] = await Promise.all([
        db
            .select({
                id: people.id,
                name: people.displayName,
                notes: people.notes,
            })
            .from(people)
            .where(and(eq(people.userId, scope), isNull(people.mergedIntoId))),
        db
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
                ),
            ),
        db
            .select({
                personId: knowledgeAliases.personId,
                entityId: knowledgeAliases.entityId,
                kind: knowledgeAliases.kind,
                text: knowledgeAliases.text,
                language: knowledgeAliases.language,
                provider: knowledgeAliases.provider,
            })
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.userId, scope)),
        db
            .select({ id: personNotes.personId, notes: personNotes.notes })
            .from(personNotes)
            .where(eq(personNotes.userId, scope)),
        db
            .select({
                id: knowledgeEntityNotes.entityId,
                notes: knowledgeEntityNotes.notes,
            })
            .from(knowledgeEntityNotes)
            .where(eq(knowledgeEntityNotes.userId, scope)),
        db
            .select({
                id: knowledgeFacts.id,
                subjectPersonId: knowledgeFacts.subjectPersonId,
                subjectEntityId: knowledgeFacts.subjectEntityId,
                relationKey: knowledgeFacts.relationKey,
                objectPersonId: knowledgeFacts.objectPersonId,
                objectEntityId: knowledgeFacts.objectEntityId,
                objectLiteral: knowledgeFacts.objectLiteral,
                origin: knowledgeFacts.origin,
            })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, scope),
                    isNull(knowledgeFacts.replacedByFactId),
                    or(
                        eq(knowledgeFacts.origin, "manual"),
                        exists(
                            db
                                .select({ id: knowledgeFactEvidence.id })
                                .from(knowledgeFactEvidence)
                                .where(
                                    and(
                                        eq(
                                            knowledgeFactEvidence.factId,
                                            knowledgeFacts.id,
                                        ),
                                        eq(
                                            knowledgeFactEvidence.status,
                                            "supported",
                                        ),
                                    ),
                                ),
                        ),
                    ),
                ),
            ),
    ]);

    const items: KnownItem[] = [
        ...personRows.map((row) => ({
            id: row.id,
            kind: "person" as const,
            typeKey: "person",
            name: decryptText(row.name),
            description: row.notes ? decryptText(row.notes) : null,
        })),
        ...entityRows.map((row) => ({
            id: row.id,
            kind: "entity" as const,
            typeKey: row.typeKey,
            name: decryptText(row.name),
            description: row.description ? decryptText(row.description) : null,
        })),
    ];
    const names: KnownName[] = aliasRows.map((row) => ({
        target: nodeOf(row.personId, row.entityId),
        kind: row.kind,
        text: decryptText(row.text),
        language: row.language,
        provider: row.provider,
    }));
    const notes = new Map(
        [...personNoteRows, ...entityNoteRows].map((row) => [
            row.id,
            decryptText(row.notes),
        ]),
    );
    const facts: KnownFact[] = factRows.map((row) => ({
        id: row.id,
        subject: nodeOf(row.subjectPersonId, row.subjectEntityId),
        relationKey: row.relationKey,
        object: row.objectLiteral
            ? { literal: decryptText(row.objectLiteral) }
            : nodeOf(row.objectPersonId, row.objectEntityId),
        origin: row.origin,
    }));
    return { items, names, notes, facts, vectors: await loadVectors(scope) };
}

/** The scope's vectors of the generation it searches, as one matrix. */
async function loadVectors(scope: string): Promise<VectorMatrix | null> {
    const [state] = await db
        .select({ activeGeneration: knowledgeVectorState.activeGeneration })
        .from(knowledgeVectorState)
        .where(eq(knowledgeVectorState.userId, scope))
        .limit(1);
    if (!state?.activeGeneration) return null;
    const rows = await db
        .select({
            entityId: knowledgeVectors.entityId,
            factId: knowledgeVectors.factId,
            vector: knowledgeVectors.vector,
        })
        .from(knowledgeVectors)
        .where(
            and(
                eq(knowledgeVectors.userId, scope),
                eq(knowledgeVectors.vectorGeneration, state.activeGeneration),
            ),
        );
    if (rows.length === 0) return null;
    return buildMatrix(
        scope,
        rows.map((row) => ({
            id: row.entityId ?? row.factId ?? "",
            kind: row.entityId ? ("entity" as const) : ("fact" as const),
            vector: decodeVector(decryptText(row.vector)),
        })),
    );
}

/**
 * How fresh a scope is, as one number: its generation, and the version of
 * its vectors, which an embedding run moves without moving the generation.
 * Zero when neither exists (the account is gone, or never knew anything).
 */
async function readFreshness(
    scopes: readonly string[],
): Promise<Map<string, number>> {
    const generations = await readScopeGenerations(db, scopes);
    if (scopes.length === 0) return generations;
    const versions = await db
        .select({
            userId: knowledgeVectorState.userId,
            vectorVersion: knowledgeVectorState.vectorVersion,
        })
        .from(knowledgeVectorState)
        .where(inArray(knowledgeVectorState.userId, [...scopes]));
    for (const row of versions) {
        const generation = generations.get(row.userId) ?? 0;
        generations.set(
            row.userId,
            generation * 2 ** 20 + (row.vectorVersion % 2 ** 20) + 1,
        );
    }
    return generations;
}

let store: KnowledgeMemoryStore | null = null;
let orgScope: string | null = null;

/** The store every request of this process shares. */
export function knowledgeStore(): KnowledgeMemoryStore {
    store ??= new KnowledgeMemoryStore({
        load: loadScopeKnowledge,
        readGenerations: readFreshness,
        maxBytes: env.KNOWLEDGE_MEMORY_MB * 1024 * 1024,
        pinnedScope: () => orgScope,
        log: (message) => console.log(message),
    });
    return store;
}

let listening = false;

/**
 * Hear of changes sooner: a notification marks its scope stale. Only an
 * accelerator; a reconnect (the listener was lost, and with it what it
 * would have said) forgets everything held. Also logs the store's counts
 * every ten minutes while it holds anything.
 */
export function startKnowledgeListener(): void {
    if (listening || !sqlClient || env.IS_HOSTED) return;
    listening = true;
    let connected = false;
    void sqlClient
        .listen(
            KNOWLEDGE_CHANNEL,
            (scope) => knowledgeStore().markStale(scope),
            () => {
                if (connected) knowledgeStore().invalidateAll();
                connected = true;
            },
        )
        .catch((error: unknown) => {
            listening = false;
            console.error("[knowledge] could not listen for changes:", error);
        });
    setInterval(
        () => {
            const stats = knowledgeStore().stats();
            if (stats.scopes > 0) {
                console.log(
                    `[knowledge] ${stats.scopes} scopes held, ${stats.bytes} bytes; ${stats.hits} hits, ${stats.loads} loads, ${stats.evictions} evictions, ${stats.dropped} dropped`,
                );
            }
        },
        10 * 60 * 1000,
    ).unref();
}

/** What one reader may know, merged from the scopes it reads. */
export interface KnowledgeView {
    items: (KnownItem & {
        scope: "personal" | "org";
        /** Its names in the view: its own, aliases and heard-as forms. */
        names: KnownName[];
        /** The reader's private notes, on an Organization item. */
        notes: string | null;
    })[];
    facts: (KnownFact & { scope: "personal" | "org" })[];
    /** The name indexes of the scopes read, for `findByName`. */
    indexes: NameIndex[];
    /** Their vectors, for `searchByMeaning`. */
    vectors: VectorMatrix[];
}

/**
 * The knowledge a reader may use, fresh: the scopes `readableScopes`
 * gives for the context, merged.
 */
export async function knowledgeView(
    context: ReadContext,
): Promise<KnowledgeView> {
    orgScope = await getOrgUserId();
    const scopes = readableScopes(context, orgScope);
    const viewerUserId = scopes.find((scope) => scope !== orgScope) ?? null;
    const loaded = await knowledgeStore().get(scopes);
    const scopeOf = (scope: string) =>
        scope === orgScope ? ("org" as const) : ("personal" as const);

    const namesById = new Map<string, KnownName[]>();
    for (const held of loaded) {
        for (const name of held.names) {
            const id =
                "personId" in name.target
                    ? name.target.personId
                    : name.target.entityId;
            namesById.set(id, [...(namesById.get(id) ?? []), name]);
        }
    }
    const own = loaded.find((held) => held.scope === viewerUserId);
    return {
        items: loaded.flatMap((held) =>
            held.items.map((item) => ({
                ...item,
                scope: scopeOf(held.scope),
                names: namesById.get(item.id) ?? [],
                notes:
                    held.scope === orgScope
                        ? (own?.notes.get(item.id) ?? null)
                        : null,
            })),
        ),
        facts: loaded.flatMap((held) =>
            held.facts.map((fact) => ({ ...fact, scope: scopeOf(held.scope) })),
        ),
        indexes: loaded.map((held) => held.index),
        vectors: loaded.flatMap((held) => (held.vectors ? [held.vectors] : [])),
    };
}

/**
 * The entities and facts in a view most like `text` in meaning, best
 * first. The text is embedded now and never stored. `available` is false
 * when there is no embedding service, or it is failing: the caller then
 * matches by words only (`findByName`), and says so.
 */
export async function searchByMeaning(
    view: KnowledgeView,
    text: string,
    k = 10,
): Promise<{ available: boolean; hits: VectorHit[] }> {
    const client = embeddingClient();
    if (!client?.available) return { available: false, hits: [] };
    try {
        const [query] = await client.embed([text]);
        if (!query) return { available: true, hits: [] };
        return { available: true, hits: topK(query, view.vectors, k) };
    } catch (error) {
        if (error instanceof EmbeddingUnavailable) {
            return { available: false, hits: [] };
        }
        throw error;
    }
}

/**
 * The people and entities in a view a name may mean, best first, with why.
 * With the language it was said in, inflected forms meet too.
 */
export function findByName(
    view: KnowledgeView,
    query: string,
    language: string | null = null,
): NameMatch[] {
    const key = stemmingLanguage(language);
    const stemmer: WordStemmer | undefined = key
        ? { key, stem: (word) => stemVariants(word, key) }
        : undefined;
    const best = new Map<string, NameMatch>();
    for (const index of view.indexes) {
        for (const match of index.match(query, stemmer)) {
            const held = best.get(match.id);
            if (!held || match.score > held.score) best.set(match.id, match);
        }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
}
