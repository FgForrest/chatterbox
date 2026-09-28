/**
 * What sharing and withdrawing a recording do to the knowledge on it.
 *
 * A shared recording is one recording, with one set of transcripts, so
 * nothing is copied to another transcript: knowledge changes scope on the
 * same one.
 *
 * - **Sharing** publishes the owner's corrections on the recording and the
 *   heard-as forms they taught to the Organization's scope, and states the
 *   owner's facts said there in the Organization's scope too, with
 *   Organization evidence beside the owner's. What names a private person
 *   or entity promotes them first. What cannot be shared stays private and
 *   is counted: a private relation or entity type the Organization has not
 *   adopted, or a single-valued fact the Organization already knows
 *   otherwise (the Organization's knowledge is not overwritten by a share).
 * - **Withdrawal** takes back everything the Organization derived from the
 *   recording: its evidence there goes, and a fact of its left without any
 *   is pruned. The corrections on the transcripts, and the heard-as forms
 *   they taught, return to the owner's scope: the owner gets the recording
 *   back as the Organization left it, which is what they saw of it all
 *   along. Promoted people and entities stay the Organization's.
 *
 * Both run inside the transaction that shares or withdraws, under the
 * Organization-people lock and the recording lock, and return the scopes
 * they touched for the caller to bump at its end.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeAliases,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    transcriptCorrections,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError } from "@/lib/errors";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import { promoteEntityInTx } from "@/lib/knowledge/entities";
import { pruneUnsupportedFactsInTx } from "@/lib/knowledge/fact-evidence";
import { nodeKey } from "@/lib/knowledge/fact-rules";
import { confirmFactInTx, type FactObject } from "@/lib/knowledge/facts";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import { promotePersonInTx } from "@/lib/knowledge/people";
import { scopesNamingInTx } from "@/lib/knowledge/scope-generation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PublishedKnowledge {
    corrections: number;
    facts: number;
    /** Left private: nothing of them could be shared. */
    privateCorrections: number;
    privateFacts: number;
    scopes: Set<string>;
}

async function transcriptIdsOf(tx: Tx, recordingId: string) {
    const rows = await tx
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .where(eq(transcriptions.recordingId, recordingId));
    return rows.map((row) => row.id);
}

/**
 * The Organization's id for a person or entity, promoting a private one;
 * null when it cannot be shared (an entity of a private type not adopted).
 */
async function sharedTargetInTx(
    tx: Tx,
    target: KnowledgeTarget,
    orgUserId: string,
): Promise<KnowledgeTarget | null> {
    if ("personId" in target) {
        const id = await promotePersonInTx(tx, target.personId, orgUserId);
        return id ? { personId: id } : null;
    }
    try {
        const id = await promoteEntityInTx(tx, target.entityId, orgUserId);
        return id ? { entityId: id } : null;
    } catch (error) {
        if (
            error instanceof AppError &&
            error.details?.reason === "entityTypePrivate"
        ) {
            return null;
        }
        throw error;
    }
}

function node(
    personId: string | null,
    entityId: string | null,
): KnowledgeTarget {
    return personId ? { personId } : { entityId: entityId ?? "" };
}

/**
 * The key an Organization relation takes for `key`: core and
 * Organization keys as they are, a private one by its adoption, or null.
 */
async function sharedRelationKeyInTx(
    tx: Tx,
    key: string,
    ownerUserId: string,
): Promise<string | null> {
    const [relation] = await tx
        .select({
            userId: knowledgeRelationTypes.userId,
            adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
            orgOwned: orgOwnedCondition(knowledgeRelationTypes.userId),
        })
        .from(knowledgeRelationTypes)
        .where(eq(knowledgeRelationTypes.key, key))
        .limit(1);
    if (!relation) return null;
    if (relation.userId === null || relation.orgOwned) return key;
    if (relation.userId === ownerUserId) return relation.adoptedAsKey;
    return null;
}

export async function publishKnowledgeInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        orgUserId,
    }: { recordingId: string; ownerUserId: string; orgUserId: string },
): Promise<PublishedKnowledge> {
    const result: PublishedKnowledge = {
        corrections: 0,
        facts: 0,
        privateCorrections: 0,
        privateFacts: 0,
        scopes: new Set([ownerUserId, orgUserId]),
    };
    const transcriptIds = await transcriptIdsOf(tx, recordingId);
    if (transcriptIds.length === 0) return result;

    const corrections = await tx
        .select({
            id: transcriptCorrections.id,
            targetPersonId: transcriptCorrections.targetPersonId,
            targetEntityId: transcriptCorrections.targetEntityId,
        })
        .from(transcriptCorrections)
        .where(
            and(
                inArray(transcriptCorrections.transcriptionId, transcriptIds),
                eq(transcriptCorrections.userId, ownerUserId),
            ),
        );
    const facts = await tx
        .selectDistinct({
            id: knowledgeFacts.id,
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            relationKey: knowledgeFacts.relationKey,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
            objectLiteral: knowledgeFacts.objectLiteral,
        })
        .from(knowledgeFacts)
        .innerJoin(
            knowledgeFactEvidence,
            eq(knowledgeFactEvidence.factId, knowledgeFacts.id),
        )
        .where(
            and(
                eq(knowledgeFacts.userId, ownerUserId),
                isNull(knowledgeFacts.replacedByFactId),
                inArray(knowledgeFactEvidence.transcriptionId, transcriptIds),
                eq(knowledgeFactEvidence.status, "supported"),
            ),
        );

    // Everyone naming what may be promoted, read before it is.
    for (const scope of await scopesNamingInTx(tx, {
        personIds: [
            ...corrections.map((row) => row.targetPersonId),
            ...facts.flatMap((row) => [
                row.subjectPersonId,
                row.objectPersonId,
            ]),
        ].filter((id): id is string => Boolean(id)),
        entityIds: [
            ...corrections.map((row) => row.targetEntityId),
            ...facts.flatMap((row) => [
                row.subjectEntityId,
                row.objectEntityId,
            ]),
        ].filter((id): id is string => Boolean(id)),
    })) {
        result.scopes.add(scope);
    }

    for (const correction of corrections) {
        const target = await sharedTargetInTx(
            tx,
            node(correction.targetPersonId, correction.targetEntityId),
            orgUserId,
        );
        if (!target) {
            result.privateCorrections++;
            continue;
        }
        const columns =
            "personId" in target
                ? { targetPersonId: target.personId, targetEntityId: null }
                : { targetPersonId: null, targetEntityId: target.entityId };
        await tx
            .update(transcriptCorrections)
            .set({ userId: orgUserId, ...columns, updatedAt: new Date() })
            .where(eq(transcriptCorrections.id, correction.id));
        await tx
            .update(knowledgeAliases)
            .set({
                userId: orgUserId,
                personId: columns.targetPersonId,
                entityId: columns.targetEntityId,
                updatedAt: new Date(),
            })
            .where(eq(knowledgeAliases.correctionId, correction.id));
        result.corrections++;
    }

    for (const fact of facts) {
        const shared = await publishFactInTx(tx, fact, {
            ownerUserId,
            orgUserId,
            transcriptIds,
        });
        if (shared) result.facts++;
        else result.privateFacts++;
    }
    return result;
}

/** One of the owner's facts, stated in the Organization's scope; see above. */
async function publishFactInTx(
    tx: Tx,
    fact: {
        id: string;
        subjectPersonId: string | null;
        subjectEntityId: string | null;
        relationKey: string;
        objectPersonId: string | null;
        objectEntityId: string | null;
        objectLiteral: string | null;
    },
    {
        ownerUserId,
        orgUserId,
        transcriptIds,
    }: { ownerUserId: string; orgUserId: string; transcriptIds: string[] },
): Promise<boolean> {
    const relationKey = await sharedRelationKeyInTx(
        tx,
        fact.relationKey,
        ownerUserId,
    );
    if (!relationKey) return false;
    const subject = await sharedTargetInTx(
        tx,
        node(fact.subjectPersonId, fact.subjectEntityId),
        orgUserId,
    );
    if (!subject) return false;
    let object: FactObject;
    if (fact.objectLiteral) {
        object = { literal: decryptText(fact.objectLiteral) };
    } else {
        const target = await sharedTargetInTx(
            tx,
            node(fact.objectPersonId, fact.objectEntityId),
            orgUserId,
        );
        if (!target) return false;
        object = target;
    }

    // The Organization's knowledge is not overwritten by a share: where it
    // holds another current value of a single-valued relation, the fact
    // stays private.
    const [relation] = await tx
        .select({ cardinality: knowledgeRelationTypes.cardinality })
        .from(knowledgeRelationTypes)
        .where(eq(knowledgeRelationTypes.key, relationKey))
        .limit(1);
    let expectedCurrentFactId: string | null = null;
    if (relation?.cardinality === "one") {
        const [current] = await tx
            .select({
                id: knowledgeFacts.id,
                objectKey: knowledgeFacts.objectKey,
            })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, orgUserId),
                    eq(knowledgeFacts.subjectKey, nodeKey(subject)),
                    eq(knowledgeFacts.relationKey, relationKey),
                    isNull(knowledgeFacts.replacedByFactId),
                ),
            )
            .limit(1);
        if (current) {
            if ("literal" in object || current.objectKey !== nodeKey(object)) {
                return false;
            }
            expectedCurrentFactId = current.id;
        }
    }

    const orgFactId = await confirmFactInTx(tx, {
        scopeUserId: orgUserId,
        actorUserId: ownerUserId,
        origin: "recording",
        subject,
        relationKey,
        object,
        expectedCurrentFactId,
    });
    const evidence = await tx
        .select()
        .from(knowledgeFactEvidence)
        .where(
            and(
                eq(knowledgeFactEvidence.factId, fact.id),
                inArray(knowledgeFactEvidence.transcriptionId, transcriptIds),
                eq(knowledgeFactEvidence.status, "supported"),
            ),
        );
    if (evidence.length > 0) {
        await tx
            .insert(knowledgeFactEvidence)
            .values(
                evidence.map(({ id: _id, ...row }) => ({
                    ...row,
                    userId: orgUserId,
                    factId: orgFactId,
                })),
            )
            .onConflictDoNothing();
    }
    return true;
}

/** Take back what the Organization derived from the recording; see above. */
export async function withdrawKnowledgeInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        orgUserId,
    }: { recordingId: string; ownerUserId: string; orgUserId: string },
): Promise<Set<string>> {
    const scopes = new Set([ownerUserId, orgUserId]);
    const transcriptIds = await transcriptIdsOf(tx, recordingId);
    if (transcriptIds.length === 0) return scopes;

    const removed = await tx
        .delete(knowledgeFactEvidence)
        .where(
            and(
                inArray(knowledgeFactEvidence.transcriptionId, transcriptIds),
                eq(knowledgeFactEvidence.userId, orgUserId),
            ),
        )
        .returning({ factId: knowledgeFactEvidence.factId });
    await pruneUnsupportedFactsInTx(tx, [
        ...new Set(removed.map((row) => row.factId)),
    ]);

    const corrections = await tx
        .update(transcriptCorrections)
        .set({ userId: ownerUserId, updatedAt: new Date() })
        .where(
            and(
                inArray(transcriptCorrections.transcriptionId, transcriptIds),
                eq(transcriptCorrections.userId, orgUserId),
            ),
        )
        .returning({ id: transcriptCorrections.id });
    if (corrections.length > 0) {
        await tx
            .update(knowledgeAliases)
            .set({ userId: ownerUserId, updatedAt: new Date() })
            .where(
                and(
                    inArray(
                        knowledgeAliases.correctionId,
                        corrections.map((row) => row.id),
                    ),
                    eq(knowledgeAliases.userId, orgUserId),
                ),
            );
    }
    return scopes;
}
