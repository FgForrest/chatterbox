import { and, eq, sql } from "drizzle-orm";
import type { db } from "@/db";
import { shareTransactionId } from "@/db/queries/almanac-share";
import {
    type AlmanacAdditionKind,
    almanacShareChanges,
    almanacShareEvents,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    people,
    personEmails,
    transcriptCorrections,
} from "@/db/schema";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import {
    planEntityPromotionInTx,
    promoteEntityInTx,
} from "@/lib/knowledge/entities";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    planPersonPromotionInTx,
    promotePersonInTx,
} from "@/lib/knowledge/people";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface ShareEvent {
    id: string;
    scope: string;
}
export interface ShareRow {
    kind: AlmanacAdditionKind;
    id: string;
    personId: string | null;
    entityId: string | null;
    fingerprint: string;
}

/** Join the publishers of this item in this transaction into one auditable share event. */
export async function shareEventInTx(
    tx: Tx,
    itemId: string,
    sharer: string,
    scope: string,
): Promise<ShareEvent> {
    const id = domainLookupHash(
        "almanac-share-event",
        `${scope}:${itemId}:${await shareTransactionId(tx)}`,
    );
    await tx
        .insert(almanacShareEvents)
        .values({
            id,
            userId: scope,
            itemId,
            sharedByUserId: sharer,
            // Transaction-start time can precede another publisher waiting on the Organization lock.
            createdAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing();
    return { id, scope };
}

/** Keyed fingerprint of ciphertext and structural metadata, never a content snapshot. */
export function shareFingerprint(value: unknown): string {
    return domainLookupHash("almanac-share-state", JSON.stringify(value));
}

/** Read only Organization rows directly affected by a publication. */
export async function shareRowsInTx(
    tx: Pick<Tx, "select">,
    scope: string,
    target: KnowledgeTarget | { factId: string } | { correctionId: string },
): Promise<ShareRow[]> {
    const rows: ShareRow[] = [];
    if ("personId" in target || "entityId" in target) {
        const personId = "personId" in target ? target.personId : null;
        const entityId = "entityId" in target ? target.entityId : null;
        const table = personId ? people : knowledgeEntities;
        const [record] = await tx
            .select()
            .from(table)
            .where(
                and(
                    eq(table.userId, scope),
                    eq(table.id, personId ?? entityId ?? ""),
                ),
            );
        if (record)
            rows.push({
                kind: personId ? "person" : "entity",
                id: record.id,
                personId,
                entityId,
                fingerprint: shareFingerprint(record),
            });
        const aliases = await tx
            .select()
            .from(knowledgeAliases)
            .where(
                and(
                    eq(knowledgeAliases.userId, scope),
                    personId
                        ? eq(knowledgeAliases.personId, personId)
                        : eq(knowledgeAliases.entityId, entityId ?? ""),
                ),
            );
        for (const row of aliases)
            rows.push({
                kind: "alias",
                id: row.id,
                personId,
                entityId,
                fingerprint: shareFingerprint(row),
            });
        if (personId) {
            const emails = await tx
                .select()
                .from(personEmails)
                .where(
                    and(
                        eq(personEmails.userId, scope),
                        eq(personEmails.personId, personId),
                    ),
                );
            for (const row of emails)
                rows.push({
                    kind: "email",
                    id: row.emailHash,
                    personId,
                    entityId: null,
                    fingerprint: shareFingerprint(row),
                });
        }
    } else if ("factId" in target) {
        const [fact] = await tx
            .select()
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, scope),
                    eq(knowledgeFacts.id, target.factId),
                ),
            );
        if (fact) {
            const evidence = await tx
                .select()
                .from(knowledgeFactEvidence)
                .where(
                    and(
                        eq(knowledgeFactEvidence.userId, scope),
                        eq(knowledgeFactEvidence.factId, fact.id),
                    ),
                )
                .orderBy(knowledgeFactEvidence.id);
            rows.push({
                kind: "fact",
                id: fact.id,
                personId: fact.subjectPersonId,
                entityId: fact.subjectEntityId,
                fingerprint: shareFingerprint({ fact, evidence }),
            });
        }
    } else {
        const [correction] = await tx
            .select()
            .from(transcriptCorrections)
            .where(
                and(
                    eq(transcriptCorrections.userId, scope),
                    eq(transcriptCorrections.id, target.correctionId),
                ),
            );
        if (correction) {
            rows.push({
                kind: "correction",
                id: correction.id,
                personId: correction.targetPersonId,
                entityId: correction.targetEntityId,
                fingerprint: shareFingerprint(correction),
            });
            const aliases = await tx
                .select()
                .from(knowledgeAliases)
                .where(
                    and(
                        eq(knowledgeAliases.userId, scope),
                        eq(knowledgeAliases.correctionId, correction.id),
                    ),
                );
            for (const row of aliases)
                rows.push({
                    kind: "alias",
                    id: row.id,
                    personId: row.personId,
                    entityId: row.entityId,
                    fingerprint: shareFingerprint(row),
                });
        }
    }
    return rows;
}

/** Record actual additions and references atomically; an existing row is only a use. */
export async function recordShareRowsInTx(
    tx: Tx,
    event: ShareEvent,
    before: ShareRow[],
    after: ShareRow[],
): Promise<void> {
    const existing = new Set(before.map((row) => `${row.kind}:${row.id}`));
    if (!after.length) return;
    await tx
        .insert(almanacShareChanges)
        .values(
            after.map((row) => ({
                userId: event.scope,
                eventId: event.id,
                kind: row.kind,
                targetId: row.id,
                recordPersonId: row.personId,
                recordEntityId: row.entityId,
                added: !existing.has(`${row.kind}:${row.id}`),
                fingerprint: row.fingerprint,
            })),
        )
        .onConflictDoUpdate({
            target: [
                almanacShareChanges.eventId,
                almanacShareChanges.kind,
                almanacShareChanges.targetId,
            ],
            set: { fingerprint: sql`excluded.fingerprint` },
        });
}

/** Promote a person and record exactly what became new Organization knowledge. */
export async function sharePersonInTx(
    tx: Tx,
    personId: string,
    scope: string,
    event: ShareEvent,
): Promise<string | null> {
    const plan = await planPersonPromotionInTx(tx, personId, scope);
    if (!plan) return null;
    const target = { personId: plan.orgPersonId };
    const before = await shareRowsInTx(tx, scope, target);
    const id = await promotePersonInTx(tx, personId, scope);
    if (id)
        await recordShareRowsInTx(
            tx,
            event,
            before,
            await shareRowsInTx(tx, scope, { personId: id }),
        );
    return id;
}

/** Promote a thing and record exactly what became new Organization knowledge. */
export async function shareEntityInTx(
    tx: Tx,
    entityId: string,
    scope: string,
    event: ShareEvent,
): Promise<string | null> {
    const plan = await planEntityPromotionInTx(tx, entityId, scope);
    if (!plan || plan.kind === "private")
        return promoteEntityInTx(tx, entityId, scope);
    const before = await shareRowsInTx(tx, scope, {
        entityId: plan.orgEntityId,
    });
    const id = await promoteEntityInTx(tx, entityId, scope);
    if (id)
        await recordShareRowsInTx(
            tx,
            event,
            before,
            await shareRowsInTx(tx, scope, { entityId: id }),
        );
    return id;
}
