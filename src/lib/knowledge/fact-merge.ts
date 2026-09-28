/**
 * Moving facts when two people, or two entities, become one.
 *
 * Every fact naming the one merged away is repointed at the survivor, in
 * every scope. Two facts that then say the same thing (the unique key:
 * scope, subject, relation, object) are combined: the evidence moves to
 * the one kept, which is manual if either was, and takes the later of
 * the two places in their chain of replacements (current if either was).
 * A single-valued relation left with two current facts keeps the one a
 * person changed last current (`settleSingleValuedInTx`); moving a fact
 * here is not a change by a person, so it leaves `updatedAt` alone.
 *
 * Imports nothing beyond schema and drizzle, so `people.ts` and
 * `entities.ts` can both use it.
 */

import { and, eq, ne, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import { knowledgeFactEvidence, knowledgeFacts } from "@/db/schema";
import {
    factGroupOf,
    settleSingleValuedInTx,
} from "@/lib/knowledge/fact-chains";
import { type FactNode, nodeKey } from "@/lib/knowledge/fact-rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function columnsOf(node: FactNode) {
    return "personId" in node
        ? { person: node.personId, entity: null }
        : { person: null, entity: node.entityId };
}

/** Repoint every fact naming `from` at `to`, combining those that collide. */
export async function moveFactsInTx(
    tx: Tx,
    from: FactNode,
    to: FactNode,
): Promise<void> {
    const fromKey = nodeKey(from);
    const toKey = nodeKey(to);
    const target = columnsOf(to);
    const naming = await tx
        .select({
            id: knowledgeFacts.id,
            userId: knowledgeFacts.userId,
            subjectKey: knowledgeFacts.subjectKey,
            relationKey: knowledgeFacts.relationKey,
            objectKey: knowledgeFacts.objectKey,
            origin: knowledgeFacts.origin,
            replacedByFactId: knowledgeFacts.replacedByFactId,
        })
        .from(knowledgeFacts)
        .where(
            or(
                eq(knowledgeFacts.subjectKey, fromKey),
                eq(knowledgeFacts.objectKey, fromKey),
            ),
        );
    const touched = new Set<string>();

    for (const fact of naming) {
        const subjectKey =
            fact.subjectKey === fromKey ? toKey : fact.subjectKey;
        const objectKey = fact.objectKey === fromKey ? toKey : fact.objectKey;
        const [same] = await tx
            .select({
                id: knowledgeFacts.id,
                origin: knowledgeFacts.origin,
                replacedByFactId: knowledgeFacts.replacedByFactId,
            })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, fact.userId),
                    eq(knowledgeFacts.subjectKey, subjectKey),
                    eq(knowledgeFacts.relationKey, fact.relationKey),
                    eq(knowledgeFacts.objectKey, objectKey),
                    ne(knowledgeFacts.id, fact.id),
                ),
            )
            .limit(1);

        if (!same) {
            await tx
                .update(knowledgeFacts)
                .set({
                    subjectKey,
                    objectKey,
                    ...(fact.subjectKey === fromKey
                        ? {
                              subjectPersonId: target.person,
                              subjectEntityId: target.entity,
                          }
                        : {}),
                    ...(fact.objectKey === fromKey
                        ? {
                              objectPersonId: target.person,
                              objectEntityId: target.entity,
                          }
                        : {}),
                })
                .where(eq(knowledgeFacts.id, fact.id));
            touched.add(factGroupOf({ ...fact, subjectKey }));
            continue;
        }

        await combineFactsInTx(tx, fact, same);
        touched.add(factGroupOf({ ...fact, subjectKey }));
    }

    await settleSingleValuedInTx(tx, touched);
}

/**
 * `fact` now says what `same` says (same scope, subject, relation and
 * object): keep `same`, give it what `fact` had (its evidence, manual
 * origin and place in the chain of replacements), and delete `fact`. The
 * caller settles the group.
 */
async function combineFactsInTx(
    tx: Tx,
    fact: { id: string; origin: string; replacedByFactId: string | null },
    same: { id: string; replacedByFactId: string | null },
): Promise<void> {
    await tx
        .update(knowledgeFactEvidence)
        .set({ factId: same.id })
        .where(
            and(
                eq(knowledgeFactEvidence.factId, fact.id),
                sql`not exists (select 1 from ${knowledgeFactEvidence} as kept where kept.fact_id = ${same.id} and kept.transcription_id = ${knowledgeFactEvidence.transcriptionId} and kept.start_ms = ${knowledgeFactEvidence.startMs} and kept.end_ms = ${knowledgeFactEvidence.endMs})`,
            ),
        );
    // `same` stands where the later of the two stood: where `fact` did
    // when `same` led to it (it was the older value), else where it is.
    // Read before anything below repoints the chain.
    const sameCameFirst = await leadsToInTx(tx, same.id, fact.id);
    let pointer =
        sameCameFirst || fact.replacedByFactId === null
            ? fact.replacedByFactId
            : same.replacedByFactId;
    if (pointer === same.id) pointer = same.replacedByFactId;
    await tx
        .update(knowledgeFacts)
        .set({ replacedByFactId: same.id })
        .where(
            and(
                eq(knowledgeFacts.replacedByFactId, fact.id),
                ne(knowledgeFacts.id, same.id),
            ),
        );
    if (fact.origin === "manual" || pointer !== same.replacedByFactId) {
        await tx
            .update(knowledgeFacts)
            .set({
                ...(fact.origin === "manual"
                    ? { origin: "manual" as const }
                    : {}),
                replacedByFactId: pointer,
            })
            .where(eq(knowledgeFacts.id, same.id));
    }
    await tx.delete(knowledgeFacts).where(eq(knowledgeFacts.id, fact.id));
}

/**
 * Move a scope's facts of relation `from` to relation `to`, combining
 * those that then say the same: a member's private relation type taking
 * back the facts stated with the Organization's type it had been adopted
 * as.
 */
export async function rekeyRelationInTx(
    tx: Tx,
    { userId, from, to }: { userId: string; from: string; to: string },
): Promise<void> {
    const facts = await tx
        .select({
            id: knowledgeFacts.id,
            userId: knowledgeFacts.userId,
            subjectKey: knowledgeFacts.subjectKey,
            objectKey: knowledgeFacts.objectKey,
            origin: knowledgeFacts.origin,
            replacedByFactId: knowledgeFacts.replacedByFactId,
        })
        .from(knowledgeFacts)
        .where(
            and(
                eq(knowledgeFacts.userId, userId),
                eq(knowledgeFacts.relationKey, from),
            ),
        );
    const touched = new Set<string>();
    for (const fact of facts) {
        const [same] = await tx
            .select({
                id: knowledgeFacts.id,
                replacedByFactId: knowledgeFacts.replacedByFactId,
            })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, userId),
                    eq(knowledgeFacts.subjectKey, fact.subjectKey),
                    eq(knowledgeFacts.relationKey, to),
                    eq(knowledgeFacts.objectKey, fact.objectKey),
                ),
            )
            .limit(1);
        if (same) {
            await combineFactsInTx(tx, fact, same);
        } else {
            await tx
                .update(knowledgeFacts)
                .set({ relationKey: to })
                .where(eq(knowledgeFacts.id, fact.id));
        }
        touched.add(factGroupOf({ ...fact, relationKey: to }));
    }
    await settleSingleValuedInTx(tx, touched);
}

/** Whether following the replacements from `from` reaches `to`. */
async function leadsToInTx(tx: Tx, from: string, to: string): Promise<boolean> {
    const seen = new Set<string>();
    let at: string | null = from;
    while (at && !seen.has(at)) {
        seen.add(at);
        const [row] = await tx
            .select({ next: knowledgeFacts.replacedByFactId })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.id, at))
            .limit(1);
        at = row?.next ?? null;
        if (at === to) return true;
    }
    return false;
}
