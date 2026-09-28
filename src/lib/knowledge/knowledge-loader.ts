/**
 * The database side of the knowledge memory store: what a scope's
 * knowledge is loaded from, the store every request of this process
 * shares, the listener that only hears of changes sooner, and the view a
 * reader gets, merged from the scopes it may read.
 */

import { and, eq, exists, isNull, or } from "drizzle-orm";
import { db, sqlClient } from "@/db";
import {
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityNotes,
    knowledgeFactEvidence,
    knowledgeFacts,
    people,
    personNotes,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import {
    KnowledgeMemoryStore,
    type KnownFact,
    type KnownItem,
    type KnownName,
    type LoadedScope,
} from "@/lib/knowledge/memory-store";
import type { NameIndex, NameMatch } from "@/lib/knowledge/name-match";
import { type ReadContext, readableScopes } from "@/lib/knowledge/scope";
import {
    KNOWLEDGE_CHANNEL,
    readScopeGenerations,
} from "@/lib/knowledge/scope-generation";
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
    return { items, names, notes, facts };
}

let store: KnowledgeMemoryStore | null = null;
let orgScope: string | null = null;

/** The store every request of this process shares. */
export function knowledgeStore(): KnowledgeMemoryStore {
    store ??= new KnowledgeMemoryStore({
        load: loadScopeKnowledge,
        readGenerations: (scopes) => readScopeGenerations(db, scopes),
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
    };
}

/** The people and entities in a view a name may mean, best first, with why. */
export function findByName(view: KnowledgeView, query: string): NameMatch[] {
    const best = new Map<string, NameMatch>();
    for (const index of view.indexes) {
        for (const match of index.match(query)) {
            const held = best.get(match.id);
            if (!held || match.score > held.score) best.set(match.id, match);
        }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
}
