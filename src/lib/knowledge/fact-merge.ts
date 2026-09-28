/**
 * Moving facts when two people, or two entities, become one.
 *
 * Every fact naming the one merged away is repointed at the survivor, in
 * every scope. Two facts that then say the same thing (the unique key:
 * scope, subject, relation, object) are combined: the evidence moves to
 * the one kept, which is manual if either was, current if either was, and
 * takes the other's place in any chain of replacements. A single-valued
 * relation left with two current facts keeps the one a person changed
 * last current and marks the other replaced by it; moving a fact here is
 * not a change by a person, so it leaves `updatedAt` alone.
 *
 * Env-free (schema and drizzle only), so `people.ts` and `entities.ts` can
 * both use it.
 */

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
} from "@/db/schema";
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
            touched.add(`${fact.userId}|${subjectKey}|${fact.relationKey}`);
            continue;
        }

        // The same fact twice: keep `same`, give it what `fact` had.
        await tx
            .update(knowledgeFactEvidence)
            .set({ factId: same.id })
            .where(
                and(
                    eq(knowledgeFactEvidence.factId, fact.id),
                    sql`not exists (select 1 from ${knowledgeFactEvidence} as kept where kept.fact_id = ${same.id} and kept.transcription_id = ${knowledgeFactEvidence.transcriptionId} and kept.start_ms = ${knowledgeFactEvidence.startMs} and kept.end_ms = ${knowledgeFactEvidence.endMs})`,
                ),
            );
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: same.id })
            .where(eq(knowledgeFacts.replacedByFactId, fact.id));
        if (fact.origin === "manual" || fact.replacedByFactId === null) {
            await tx
                .update(knowledgeFacts)
                .set({
                    ...(fact.origin === "manual"
                        ? { origin: "manual" as const }
                        : {}),
                    ...(fact.replacedByFactId === null
                        ? { replacedByFactId: null }
                        : {}),
                })
                .where(eq(knowledgeFacts.id, same.id));
        }
        await tx.delete(knowledgeFacts).where(eq(knowledgeFacts.id, fact.id));
        touched.add(`${fact.userId}|${subjectKey}|${fact.relationKey}`);
    }

    await settleSingleValuedInTx(tx, touched);
}

/**
 * A single-valued relation holds one current fact per subject: where a
 * merge left two, the most recently changed stays current.
 */
async function settleSingleValuedInTx(
    tx: Tx,
    groups: ReadonlySet<string>,
): Promise<void> {
    for (const group of groups) {
        const [userId = "", subjectKey = "", relationKey = ""] =
            group.split("|");
        const [relation] = await tx
            .select({ cardinality: knowledgeRelationTypes.cardinality })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, relationKey))
            .limit(1);
        if (relation?.cardinality !== "one") continue;
        const current = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, userId),
                    eq(knowledgeFacts.subjectKey, subjectKey),
                    eq(knowledgeFacts.relationKey, relationKey),
                    isNull(knowledgeFacts.replacedByFactId),
                ),
            )
            .orderBy(
                sql`${knowledgeFacts.updatedAt} desc, ${knowledgeFacts.id}`,
            );
        const [kept, ...others] = current;
        if (!kept || others.length === 0) continue;
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: kept.id })
            .where(
                inArray(
                    knowledgeFacts.id,
                    others.map((fact) => fact.id),
                ),
            );
    }
}
