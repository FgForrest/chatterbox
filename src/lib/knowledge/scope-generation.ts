/**
 * The generation counters that tell a process holding knowledge in memory
 * (`memory-store.ts`) that a scope changed.
 *
 * Every transaction that changes what a scope knows calls `bumpScopeInTx`
 * once, as its last statement, with every scope it touched: helpers return
 * the scopes they touched instead of bumping. The counters are then taken
 * in sorted order after every other lock, so two transactions touching the
 * same scopes never wait on each other the wrong way round.
 *
 * Env-free: the transcript writers load it through the rewrite hook.
 */

import { eq, inArray, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityNotes,
    knowledgeFacts,
    knowledgeScopeGenerations,
    people,
    personNotes,
    transcriptCorrections,
} from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

/** The channel a bump notifies on; only an accelerator for readers. */
export const KNOWLEDGE_CHANNEL = "riffado_knowledge";

/** Move the generation of every scope in `scopes`, and say so on the channel. */
export async function bumpScopeInTx(
    tx: Tx,
    scopes: Iterable<string | null | undefined>,
): Promise<void> {
    const sorted = [
        ...new Set(
            [...scopes].filter((scope): scope is string => Boolean(scope)),
        ),
    ].sort();
    for (const scope of sorted) {
        await tx
            .insert(knowledgeScopeGenerations)
            .values({ userId: scope, generation: 1 })
            .onConflictDoUpdate({
                target: knowledgeScopeGenerations.userId,
                set: {
                    generation: sql`${knowledgeScopeGenerations.generation} + 1`,
                    updatedAt: new Date(),
                },
            });
        await tx.execute(sql`select pg_notify(${KNOWLEDGE_CHANNEL}, ${scope})`);
    }
}

/**
 * The generations of `scopes`, in one query. A scope nothing was ever
 * written to has none, and reads as 0.
 */
export async function readScopeGenerations(
    executor: Executor,
    scopes: readonly string[],
): Promise<Map<string, number>> {
    const generations = new Map(scopes.map((scope) => [scope, 0]));
    if (scopes.length === 0) return generations;
    const rows = await executor
        .select({
            userId: knowledgeScopeGenerations.userId,
            generation: knowledgeScopeGenerations.generation,
        })
        .from(knowledgeScopeGenerations)
        .where(inArray(knowledgeScopeGenerations.userId, [...scopes]));
    for (const row of rows) generations.set(row.userId, row.generation);
    return generations;
}

/** A set of scopes a transaction touched, to bump once at its end. */
export function scopeSet(
    ...scopes: (string | null | undefined)[]
): Set<string> {
    return new Set(scopes.filter((scope): scope is string => Boolean(scope)));
}

/**
 * Every scope that knows something about these people or entities: their
 * owners', and whoever holds an alias, a note, a fact or a correction
 * naming them. Read before they are deleted or changed, since the cascade
 * or the change reaches all of them.
 */
export async function scopesNamingInTx(
    tx: Tx,
    {
        personIds = [],
        entityIds = [],
    }: { personIds?: readonly string[]; entityIds?: readonly string[] },
): Promise<Set<string>> {
    const found = new Set<string>();
    const add = (rows: { userId: string }[]) => {
        for (const row of rows) found.add(row.userId);
    };
    if (personIds.length > 0) {
        const ids = [...personIds];
        add(
            await tx
                .selectDistinct({ userId: people.userId })
                .from(people)
                .where(inArray(people.id, ids)),
        );
        add(
            await tx
                .selectDistinct({ userId: knowledgeAliases.userId })
                .from(knowledgeAliases)
                .where(inArray(knowledgeAliases.personId, ids)),
        );
        add(
            await tx
                .selectDistinct({ userId: personNotes.userId })
                .from(personNotes)
                .where(inArray(personNotes.personId, ids)),
        );
        add(
            await tx
                .selectDistinct({ userId: knowledgeFacts.userId })
                .from(knowledgeFacts)
                .where(
                    or(
                        inArray(knowledgeFacts.subjectPersonId, ids),
                        inArray(knowledgeFacts.objectPersonId, ids),
                    ),
                ),
        );
        add(
            await tx
                .selectDistinct({ userId: transcriptCorrections.userId })
                .from(transcriptCorrections)
                .where(inArray(transcriptCorrections.targetPersonId, ids)),
        );
    }
    if (entityIds.length > 0) {
        const ids = [...entityIds];
        add(
            await tx
                .selectDistinct({ userId: knowledgeEntities.userId })
                .from(knowledgeEntities)
                .where(inArray(knowledgeEntities.id, ids)),
        );
        add(
            await tx
                .selectDistinct({ userId: knowledgeAliases.userId })
                .from(knowledgeAliases)
                .where(inArray(knowledgeAliases.entityId, ids)),
        );
        add(
            await tx
                .selectDistinct({ userId: knowledgeEntityNotes.userId })
                .from(knowledgeEntityNotes)
                .where(inArray(knowledgeEntityNotes.entityId, ids)),
        );
        add(
            await tx
                .selectDistinct({ userId: knowledgeFacts.userId })
                .from(knowledgeFacts)
                .where(
                    or(
                        inArray(knowledgeFacts.subjectEntityId, ids),
                        inArray(knowledgeFacts.objectEntityId, ids),
                    ),
                ),
        );
        add(
            await tx
                .selectDistinct({ userId: transcriptCorrections.userId })
                .from(transcriptCorrections)
                .where(inArray(transcriptCorrections.targetEntityId, ids)),
        );
    }
    return found;
}

/**
 * Every scope with an entity of an entity type, or a fact of a relation
 * type: the scopes whose knowledge reads differently when the type is
 * renamed or deleted.
 */
export async function scopesUsingTypeInTx(
    tx: Tx,
    kind: "entity" | "relation",
    key: string,
): Promise<Set<string>> {
    const rows =
        kind === "entity"
            ? await tx
                  .selectDistinct({ userId: knowledgeEntities.userId })
                  .from(knowledgeEntities)
                  .where(eq(knowledgeEntities.typeKey, key))
            : await tx
                  .selectDistinct({ userId: knowledgeFacts.userId })
                  .from(knowledgeFacts)
                  .where(eq(knowledgeFacts.relationKey, key));
    return new Set(rows.map((row) => row.userId));
}
