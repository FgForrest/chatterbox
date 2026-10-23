import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    shareRecordHasOtherSources,
    shareRecordWasMerged,
} from "@/db/queries/almanac-share";
import {
    type AlmanacAdditionKind,
    almanacShareChanges,
    almanacShareEvents,
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFacts,
    people,
    personEmails,
    transcriptCorrections,
    users,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import { deleteEntityInTx } from "@/lib/knowledge/entities";
import { deleteFactsInTx } from "@/lib/knowledge/fact-chains";
import {
    lockOrgPeople,
    lockRecordingsNaming,
    recordingSharedCondition,
} from "@/lib/knowledge/org-people";
import { deletePersonInTx } from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { type ShareRow, shareRowsInTx } from "@/lib/knowledge/share-provenance";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Change = typeof almanacShareChanges.$inferSelect;
export type KeptReason = NonNullable<Change["keptReason"]>;
export interface ShareAddition {
    id: string;
    kind: AlmanacAdditionKind;
    targetId: string;
    personId: string | null;
    entityId: string | null;
    label: string | null;
    removedAt: string | null;
    keptReason: KeptReason | null;
}
export interface SharedAdditionsGroup {
    id: string;
    item: { id: string; title: string } | null;
    sharer: string | null;
    createdAt: string;
    reviewedAt: string | null;
    undoneAt: string | null;
    additions: ShareAddition[];
    nextOffset: number | null;
}
export interface SharedAdditionsPage {
    groups: SharedAdditionsGroup[];
    nextOffset: number | null;
    openCount: number;
}
export interface ShareUndoResult {
    removed: string[];
    kept: { id: string; reason: KeptReason }[];
}

function recent() {
    return new Date(Date.now() - 14 * 86400000);
}

/** Number of recent, unreviewed share groups that actually added knowledge. */
export async function shareReviewCount(actorId: string): Promise<number> {
    const scope = await requireCareCurator(actorId);
    const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(almanacShareEvents)
        .where(
            and(
                eq(almanacShareEvents.userId, scope),
                gte(almanacShareEvents.createdAt, recent()),
                isNull(almanacShareEvents.reviewedAt),
                isNull(almanacShareEvents.undoneAt),
                sql`exists (${db
                    .select({ id: almanacShareChanges.id })
                    .from(almanacShareChanges)
                    .where(
                        and(
                            eq(almanacShareChanges.userId, scope),
                            eq(
                                almanacShareChanges.eventId,
                                almanacShareEvents.id,
                            ),
                            eq(almanacShareChanges.added, true),
                        ),
                    )})`,
            ),
        );
    return rows[0]?.count ?? 0;
}

async function additionLabels(
    scope: string,
    changes: Change[],
): Promise<Map<string, string>> {
    const ids = (kind: AlmanacAdditionKind) =>
        changes.filter((row) => row.kind === kind).map((row) => row.targetId);
    const [aliases, emails, corrections, facts] = await Promise.all([
        ids("alias").length
            ? db
                  .select()
                  .from(knowledgeAliases)
                  .where(
                      and(
                          eq(knowledgeAliases.userId, scope),
                          inArray(knowledgeAliases.id, ids("alias")),
                      ),
                  )
            : [],
        ids("email").length
            ? db
                  .select()
                  .from(personEmails)
                  .where(
                      and(
                          eq(personEmails.userId, scope),
                          inArray(personEmails.emailHash, ids("email")),
                      ),
                  )
            : [],
        ids("correction").length
            ? db
                  .select()
                  .from(transcriptCorrections)
                  .where(
                      and(
                          eq(transcriptCorrections.userId, scope),
                          inArray(transcriptCorrections.id, ids("correction")),
                      ),
                  )
            : [],
        ids("fact").length
            ? db
                  .select()
                  .from(knowledgeFacts)
                  .where(
                      and(
                          eq(knowledgeFacts.userId, scope),
                          inArray(knowledgeFacts.id, ids("fact")),
                      ),
                  )
            : [],
    ]);
    const personIds = [
        ...new Set([
            ...ids("person"),
            ...facts
                .flatMap((row) => [row.subjectPersonId, row.objectPersonId])
                .filter((id): id is string => Boolean(id)),
        ]),
    ];
    const entityIds = [
        ...new Set([
            ...ids("entity"),
            ...facts
                .flatMap((row) => [row.subjectEntityId, row.objectEntityId])
                .filter((id): id is string => Boolean(id)),
        ]),
    ];
    const [persons, entities] = await Promise.all([
        personIds.length
            ? db
                  .select()
                  .from(people)
                  .where(
                      and(
                          eq(people.userId, scope),
                          inArray(people.id, personIds),
                      ),
                  )
            : [],
        entityIds.length
            ? db
                  .select()
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.userId, scope),
                          inArray(knowledgeEntities.id, entityIds),
                      ),
                  )
            : [],
    ]);
    const names = new Map([
        ...persons.map(
            (row) => [row.id, decryptText(row.displayName)] as const,
        ),
        ...entities.map((row) => [row.id, decryptText(row.name)] as const),
    ]);
    const labels = new Map<string, string>();
    for (const row of changes) {
        let label: string | null = null;
        if (row.kind === "person" || row.kind === "entity")
            label = names.get(row.targetId) ?? null;
        else if (row.kind === "alias") {
            const alias = aliases.find((alias) => alias.id === row.targetId);
            label = alias ? decryptText(alias.text) : null;
        } else if (row.kind === "email") {
            const email = emails.find(
                (email) => email.emailHash === row.targetId,
            );
            label = email ? decryptText(email.email) : null;
        } else if (row.kind === "correction") {
            const correction = corrections.find(
                (correction) => correction.id === row.targetId,
            );
            label = correction
                ? [
                      decryptText(correction.heard),
                      correction.replacement
                          ? decryptText(correction.replacement)
                          : names.get(
                                correction.targetPersonId ??
                                    correction.targetEntityId ??
                                    "",
                            ),
                  ]
                      .filter(Boolean)
                      .join(" → ")
                : null;
        } else {
            const fact = facts.find((fact) => fact.id === row.targetId);
            label = fact
                ? [
                      names.get(
                          fact.subjectPersonId ?? fact.subjectEntityId ?? "",
                      ),
                      fact.objectLiteral
                          ? decryptText(fact.objectLiteral)
                          : names.get(
                                fact.objectPersonId ??
                                    fact.objectEntityId ??
                                    "",
                            ),
                  ]
                      .filter(Boolean)
                      .join(" · ")
                : null;
        }
        if (label) labels.set(row.id, label);
    }
    return labels;
}

/** Show only the item's current Organization view, never the sharer's private title after withdrawal. */
export async function listSharedAdditions(
    actorId: string,
    offset = 0,
    eventId?: string,
    additionOffset = 0,
): Promise<SharedAdditionsPage> {
    const scope = await requireCareCurator(actorId);
    const events = await db
        .select()
        .from(almanacShareEvents)
        .where(
            and(
                eq(almanacShareEvents.userId, scope),
                eventId
                    ? eq(almanacShareEvents.id, eventId)
                    : gte(almanacShareEvents.createdAt, recent()),
                sql`exists (${db
                    .select({ id: almanacShareChanges.id })
                    .from(almanacShareChanges)
                    .where(
                        and(
                            eq(almanacShareChanges.userId, scope),
                            eq(
                                almanacShareChanges.eventId,
                                almanacShareEvents.id,
                            ),
                            eq(almanacShareChanges.added, true),
                        ),
                    )})`,
            ),
        )
        .orderBy(desc(almanacShareEvents.createdAt), almanacShareEvents.id)
        .offset(offset)
        .limit(eventId ? 1 : 21);
    if (eventId && !events.length)
        throw new AppError(ErrorCode.NOT_FOUND, "Share event not found", 404);
    const groups: SharedAdditionsGroup[] = [];
    for (const event of events.slice(0, 20)) {
        const changes = await db
            .select()
            .from(almanacShareChanges)
            .where(
                and(
                    eq(almanacShareChanges.userId, scope),
                    eq(almanacShareChanges.eventId, event.id),
                    eq(almanacShareChanges.added, true),
                ),
            )
            .orderBy(almanacShareChanges.id)
            .offset(additionOffset)
            .limit(101);
        const [item] = event.itemId
            ? await db
                  .select({ id: chatterItems.id, title: chatterItems.title })
                  .from(chatterItems)
                  .where(
                      and(
                          eq(chatterItems.id, event.itemId),
                          isNull(chatterItems.deletedAt),
                          recordingSharedCondition(chatterItems.id),
                      ),
                  )
                  .limit(1)
            : [];
        const [sharer] = event.sharedByUserId
            ? await db
                  .select({ name: users.name })
                  .from(users)
                  .where(eq(users.id, event.sharedByUserId))
                  .limit(1)
            : [];
        const labels = await additionLabels(scope, changes.slice(0, 100));
        const additions = changes.slice(0, 100).map((row) => ({
            id: row.id,
            kind: row.kind,
            targetId: row.targetId,
            personId: row.recordPersonId,
            entityId: row.recordEntityId,
            label: labels.get(row.id) ?? null,
            removedAt: row.removedAt?.toISOString() ?? null,
            keptReason: row.keptReason,
        }));
        groups.push({
            id: event.id,
            item: item ? { id: item.id, title: decryptText(item.title) } : null,
            sharer: sharer?.name ?? null,
            createdAt: event.createdAt.toISOString(),
            reviewedAt: event.reviewedAt?.toISOString() ?? null,
            undoneAt: event.undoneAt?.toISOString() ?? null,
            additions,
            nextOffset: changes.length > 100 ? additionOffset + 100 : null,
        });
    }
    return {
        groups,
        nextOffset: events.length > 20 ? offset + 20 : null,
        openCount: await shareReviewCount(actorId),
    };
}

/** A curator has reviewed a share's additions; the item stays shared. */
export async function reviewShare(
    actorId: string,
    eventId: string,
): Promise<void> {
    const scope = await requireCareCurator(actorId);
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireCareCurator(actorId);
        const [row] = await tx
            .update(almanacShareEvents)
            .set({ reviewedAt: new Date(), reviewedByUserId: actorId })
            .where(
                and(
                    eq(almanacShareEvents.userId, scope),
                    eq(almanacShareEvents.id, eventId),
                    isNull(almanacShareEvents.reviewedAt),
                ),
            )
            .returning({ id: almanacShareEvents.id });
        if (!row) {
            const [existing] = await tx
                .select({ id: almanacShareEvents.id })
                .from(almanacShareEvents)
                .where(
                    and(
                        eq(almanacShareEvents.userId, scope),
                        eq(almanacShareEvents.id, eventId),
                    ),
                )
                .limit(1);
            if (!existing)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Share event not found",
                    404,
                );
        }
        await bumpScopeInTx(tx, [scope]);
    });
}

async function currentRow(
    tx: Tx,
    scope: string,
    change: Change,
): Promise<ShareRow | undefined> {
    const target =
        change.kind === "person"
            ? { personId: change.targetId }
            : change.kind === "entity"
              ? { entityId: change.targetId }
              : change.kind === "fact"
                ? { factId: change.targetId }
                : change.kind === "correction"
                  ? { correctionId: change.targetId }
                  : change.recordPersonId
                    ? { personId: change.recordPersonId }
                    : { entityId: change.recordEntityId ?? "" };
    return (await shareRowsInTx(tx, scope, target)).find(
        (row) => row.kind === change.kind && row.id === change.targetId,
    );
}

/** Undo only untouched additions. Persistent outcomes make retries idempotent across processes. */
export async function undoShareAdditions(
    actorId: string,
    eventId: string,
    additionId?: string,
): Promise<ShareUndoResult> {
    const scope = await requireCareCurator(actorId);
    return db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireCareCurator(actorId);
        const [event] = await tx
            .select()
            .from(almanacShareEvents)
            .where(
                and(
                    eq(almanacShareEvents.userId, scope),
                    eq(almanacShareEvents.id, eventId),
                ),
            )
            .for("update")
            .limit(1);
        if (!event)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Share event not found",
                404,
            );
        const changes = await tx
            .select()
            .from(almanacShareChanges)
            .where(
                and(
                    eq(almanacShareChanges.userId, scope),
                    eq(almanacShareChanges.eventId, eventId),
                    eq(almanacShareChanges.added, true),
                ),
            )
            .orderBy(almanacShareChanges.id);
        if (additionId && !changes.some((row) => row.id === additionId))
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Share addition not found",
                404,
            );
        const selected = additionId
            ? changes.filter((row) => row.id === additionId)
            : changes;
        const result: ShareUndoResult = { removed: [], kept: [] };
        if (event.undoneAt) {
            for (const row of selected) {
                if (row.removedAt) result.removed.push(row.id);
                else
                    result.kept.push({
                        id: row.id,
                        reason: row.keptReason ?? "gone",
                    });
            }
            return result;
        }
        await lockRecordingsNaming(tx, {
            personIds: changes.flatMap((r) =>
                r.recordPersonId ? [r.recordPersonId] : [],
            ),
            entityIds: changes.flatMap((r) =>
                r.recordEntityId ? [r.recordEntityId] : [],
            ),
            factIds: changes
                .filter((r) => r.kind === "fact")
                .map((r) => r.targetId),
        });
        const removable = new Map<string, Change>();
        const reasons = new Map<string, KeptReason>();
        for (const change of selected) {
            if (change.removedAt) {
                result.removed.push(change.id);
                continue;
            }
            if (
                (change.kind === "person" || change.kind === "entity") &&
                (await shareRecordWasMerged(
                    tx,
                    scope,
                    change.kind,
                    change.targetId,
                ))
            ) {
                reasons.set(change.id, "merged");
                continue;
            }
            const current = await currentRow(tx, scope, change);
            if (!current) {
                reasons.set(change.id, "gone");
                continue;
            }
            const [later] = await tx
                .select({ id: almanacShareChanges.id })
                .from(almanacShareChanges)
                .innerJoin(
                    almanacShareEvents,
                    eq(almanacShareEvents.id, almanacShareChanges.eventId),
                )
                .where(
                    and(
                        eq(almanacShareChanges.userId, scope),
                        eq(almanacShareChanges.kind, change.kind),
                        eq(almanacShareChanges.targetId, change.targetId),
                        ne(almanacShareChanges.eventId, eventId),
                        gte(almanacShareEvents.createdAt, event.createdAt),
                    ),
                )
                .limit(1);
            if (later) {
                reasons.set(change.id, "later_share");
                continue;
            }
            if (current.fingerprint !== change.fingerprint) {
                reasons.set(change.id, "changed");
                continue;
            }
            removable.set(change.id, change);
        }
        for (const change of [...removable.values()].filter(
            (row) => row.kind === "fact",
        )) {
            const [dependent] = await tx
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(
                    and(
                        eq(knowledgeFacts.userId, scope),
                        eq(knowledgeFacts.replacedByFactId, change.targetId),
                    ),
                )
                .limit(1);
            if (dependent) {
                removable.delete(change.id);
                reasons.set(change.id, "other_source");
            }
        }
        for (const change of [...removable.values()].filter(
            (row) => row.kind === "correction",
        )) {
            const aliases = await tx
                .select({ id: knowledgeAliases.id })
                .from(knowledgeAliases)
                .where(eq(knowledgeAliases.correctionId, change.targetId));
            if (
                aliases.some(
                    (alias) =>
                        ![...removable.values()].some(
                            (row) =>
                                row.kind === "alias" &&
                                row.targetId === alias.id,
                        ),
                )
            ) {
                removable.delete(change.id);
                reasons.set(change.id, "other_source");
            }
        }
        const targets = (kind: AlmanacAdditionKind) =>
            [...removable.values()]
                .filter((row) => row.kind === kind)
                .map((row) => row.targetId);
        for (const change of [...removable.values()].filter(
            (row) => row.kind === "person" || row.kind === "entity",
        )) {
            if (
                await shareRecordHasOtherSources(tx, {
                    scope,
                    kind: change.kind as "person" | "entity",
                    id: change.targetId,
                    itemId: event.itemId,
                    since: event.createdAt,
                    facts: targets("fact"),
                    corrections: targets("correction"),
                    aliases: targets("alias"),
                    emails: targets("email"),
                })
            ) {
                removable.delete(change.id);
                reasons.set(change.id, "other_source");
            }
        }
        const scopes = new Set([scope]);
        for (const kind of [
            "alias",
            "email",
            "correction",
            "fact",
            "person",
            "entity",
        ] as const) {
            for (const change of [...removable.values()].filter(
                (row) => row.kind === kind,
            )) {
                if (kind === "person")
                    for (const s of await deletePersonInTx(
                        tx,
                        actorId,
                        change.targetId,
                    ))
                        scopes.add(s);
                else if (kind === "entity")
                    for (const s of await deleteEntityInTx(
                        tx,
                        actorId,
                        change.targetId,
                    ))
                        scopes.add(s);
                else if (kind === "fact")
                    await deleteFactsInTx(tx, [change.targetId]);
                else if (kind === "email")
                    await tx
                        .delete(personEmails)
                        .where(
                            and(
                                eq(personEmails.userId, scope),
                                eq(personEmails.emailHash, change.targetId),
                            ),
                        );
                else {
                    const table =
                        kind === "alias"
                            ? knowledgeAliases
                            : transcriptCorrections;
                    await tx
                        .delete(table)
                        .where(
                            and(
                                eq(table.userId, scope),
                                eq(table.id, change.targetId),
                            ),
                        );
                }
                await tx
                    .update(almanacShareChanges)
                    .set({
                        removedAt: new Date(),
                        removedByUserId: actorId,
                        keptReason: null,
                    })
                    .where(
                        and(
                            eq(almanacShareChanges.userId, scope),
                            eq(almanacShareChanges.id, change.id),
                        ),
                    );
                result.removed.push(change.id);
            }
        }
        for (const [id, reason] of reasons) {
            await tx
                .update(almanacShareChanges)
                .set({ keptReason: reason })
                .where(
                    and(
                        eq(almanacShareChanges.userId, scope),
                        eq(almanacShareChanges.id, id),
                    ),
                );
            result.kept.push({ id, reason });
        }
        if (!additionId)
            await tx
                .update(almanacShareEvents)
                .set({
                    undoneAt: new Date(),
                    undoneByUserId: actorId,
                    reviewedAt: event.reviewedAt ?? new Date(),
                    reviewedByUserId: event.reviewedByUserId ?? actorId,
                })
                .where(
                    and(
                        eq(almanacShareEvents.userId, scope),
                        eq(almanacShareEvents.id, eventId),
                    ),
                );
        await bumpScopeInTx(tx, scopes);
        return result;
    });
}
