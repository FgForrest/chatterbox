/**
 * The replacement chains of single-valued relations, kept whole when facts
 * go.
 *
 * A fact a newer value replaced points at it (`replacedByFactId`); the
 * current one points nowhere. Deleting a fact the plain way lets the
 * foreign key null its predecessors' pointers: right when it was current
 * (the value before it is the last one still said), wrong in the middle
 * of a chain, where an older value would become current beside the
 * newest. So a fact that goes first hands its predecessors to its
 * successor, and every group it leaves (scope, subject, relation) is
 * settled to one current value.
 *
 * Every deletion of facts goes through here: decay, a person deleting a
 * fact, and a person, entity or entity type going with the facts naming
 * them. Imports nothing beyond schema and drizzle: the transcript
 * deletions load it.
 */

import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { db } from "@/db";
import { knowledgeFacts, knowledgeRelationTypes } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One relation of one subject in one scope: `userId|subjectKey|relationKey`. */
export function factGroupOf(fact: {
    userId: string;
    subjectKey: string;
    relationKey: string;
}): string {
    return `${fact.userId}|${fact.subjectKey}|${fact.relationKey}`;
}

/** Delete `factIds` (evidence and all), keeping their chains whole. */
export async function deleteFactsInTx(
    tx: Tx,
    factIds: readonly string[],
): Promise<void> {
    if (factIds.length === 0) return;
    const doomed = [...new Set(factIds)];
    const rows = await tx
        .select({
            id: knowledgeFacts.id,
            userId: knowledgeFacts.userId,
            subjectKey: knowledgeFacts.subjectKey,
            relationKey: knowledgeFacts.relationKey,
            replacedByFactId: knowledgeFacts.replacedByFactId,
        })
        .from(knowledgeFacts)
        .where(inArray(knowledgeFacts.id, doomed));
    if (rows.length === 0) return;

    const going = new Set(doomed);
    const next = new Map(rows.map((row) => [row.id, row.replacedByFactId]));
    // The first fact after `id` that stays, or null when none does.
    const survivorAfter = (id: string): string | null => {
        const seen = new Set<string>();
        let at = next.get(id) ?? null;
        while (at && going.has(at)) {
            if (seen.has(at)) return null;
            seen.add(at);
            at = next.get(at) ?? null;
        }
        return at;
    };
    for (const row of rows) {
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: survivorAfter(row.id) })
            .where(
                and(
                    eq(knowledgeFacts.replacedByFactId, row.id),
                    notInArray(knowledgeFacts.id, doomed),
                ),
            );
    }
    await tx.delete(knowledgeFacts).where(inArray(knowledgeFacts.id, doomed));
    await settleSingleValuedInTx(tx, new Set(rows.map(factGroupOf)));
}

/** Delete every fact naming one of these people or entities; see above. */
export async function deleteFactsNamingInTx(
    tx: Tx,
    {
        personIds = [],
        entityIds = [],
    }: { personIds?: readonly string[]; entityIds?: readonly string[] },
): Promise<void> {
    const naming = [
        ...(personIds.length > 0
            ? [
                  inArray(knowledgeFacts.subjectPersonId, [...personIds]),
                  inArray(knowledgeFacts.objectPersonId, [...personIds]),
              ]
            : []),
        ...(entityIds.length > 0
            ? [
                  inArray(knowledgeFacts.subjectEntityId, [...entityIds]),
                  inArray(knowledgeFacts.objectEntityId, [...entityIds]),
              ]
            : []),
    ];
    if (naming.length === 0) return;
    const rows = await tx
        .select({ id: knowledgeFacts.id })
        .from(knowledgeFacts)
        .where(or(...naming));
    await deleteFactsInTx(
        tx,
        rows.map((row) => row.id),
    );
}

/**
 * A single-valued relation holds one current fact per subject. Where a
 * group has several (a merge combined two chains, a deleted fact had two
 * predecessors), the one a person changed last stays current and the
 * others are replaced by it; where it has none (a cycle), the one changed
 * last becomes current.
 */
export async function settleSingleValuedInTx(
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
        const facts = await tx
            .select({
                id: knowledgeFacts.id,
                replacedByFactId: knowledgeFacts.replacedByFactId,
            })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, userId),
                    eq(knowledgeFacts.subjectKey, subjectKey),
                    eq(knowledgeFacts.relationKey, relationKey),
                ),
            )
            .orderBy(
                sql`${knowledgeFacts.updatedAt} desc, ${knowledgeFacts.id}`,
            );
        const current = facts.filter((fact) => fact.replacedByFactId === null);
        const [latest] = facts;
        if (current.length === 0 && latest) {
            await tx
                .update(knowledgeFacts)
                .set({ replacedByFactId: null })
                .where(eq(knowledgeFacts.id, latest.id));
            continue;
        }
        const [kept, ...others] = current;
        if (!kept || others.length === 0) continue;
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: kept.id })
            .where(
                and(
                    inArray(
                        knowledgeFacts.id,
                        others.map((fact) => fact.id),
                    ),
                    isNull(knowledgeFacts.replacedByFactId),
                ),
            );
    }
}
