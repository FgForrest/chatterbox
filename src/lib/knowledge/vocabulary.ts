/**
 * The knowledge vocabulary in the database: core types (seeded), the
 * Organization's, and each user's private ones.
 *
 * Who may do what:
 * - a user creates, renames and deletes their own private types, and
 *   suggests relation phrases to the Organization (only the phrase goes);
 * - the organization account creates Organization types and adopts
 *   suggested phrases;
 * - core types change only with the code.
 *
 * Every change bumps the vocabulary version in its transaction, so a Learn
 * run can tell the vocabulary it was made with is no longer current.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeFacts,
    knowledgeRelationTypes,
    knowledgeVocabularyProposals,
    knowledgeVocabularyProposalVotes,
    knowledgeVocabularyVersion,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    deleteFactsInTx,
    deleteFactsNamingInTx,
} from "@/lib/knowledge/fact-chains";
import { rekeyRelationInTx } from "@/lib/knowledge/fact-merge";
import { relationFits } from "@/lib/knowledge/fact-rules";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    lockOrgPeople,
    lockRecordingsNaming,
    orgOwnedCondition,
} from "@/lib/knowledge/org-people";
import {
    bumpScopeInTx,
    scopesNamingInTx,
    scopesUsingTypeInTx,
} from "@/lib/knowledge/scope-generation";
import {
    CORE_ENTITY_TYPES,
    CORE_RELATIONS,
    deniedTopicOf,
} from "@/lib/knowledge/vocabulary-core";
import { isOrgAccount } from "@/lib/org/config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

export type TypeKind = "entity" | "relation";
export type TypeLayer = "core" | "org" | "private";

export const MAX_TYPE_LABEL_LENGTH = 80;

export interface EntityType {
    kind: "entity";
    key: string;
    label: string;
    layer: TypeLayer;
    /** A private type the Organization adopted: new facts use this key. */
    adoptedAsKey: string | null;
}

export interface RelationType {
    kind: "relation";
    key: string;
    label: string;
    layer: TypeLayer;
    adoptedAsKey: string | null;
    subjectTypes: string[];
    objectTypes: string[];
    objectKind: "entity" | "literal";
    cardinality: "one" | "many";
}

export interface Vocabulary {
    entityTypes: EntityType[];
    relationTypes: RelationType[];
}

const LABEL_DOMAIN: Record<TypeKind, string> = {
    entity: "entity-type-label",
    relation: "relation-type-label",
};
const PHRASE_DOMAIN = "vocabulary-phrase";

function tableOf(kind: TypeKind) {
    return kind === "entity" ? knowledgeEntityTypes : knowledgeRelationTypes;
}

/** Make the vocabulary's version one higher; last in its transaction. */
export async function bumpVocabularyVersionInTx(tx: Tx): Promise<void> {
    await tx
        .insert(knowledgeVocabularyVersion)
        .values({ id: 1, version: 1 })
        .onConflictDoUpdate({
            target: knowledgeVocabularyVersion.id,
            set: { version: sql`${knowledgeVocabularyVersion.version} + 1` },
        });
}

/** The vocabulary's current version (0 before anything changed it). */
export async function vocabularyVersion(
    executor: Executor = db,
): Promise<number> {
    const [row] = await executor
        .select({ version: knowledgeVocabularyVersion.version })
        .from(knowledgeVocabularyVersion)
        .where(eq(knowledgeVocabularyVersion.id, 1))
        .limit(1);
    return row?.version ?? 0;
}

/**
 * Write the core vocabulary, or bring it up to date with the code.
 * Idempotent: a row the code has not changed is left alone, and the version
 * moves only when a core row was added or changed.
 */
export async function seedCoreVocabulary(): Promise<void> {
    await db.transaction(async (tx) => {
        // What changed, so the scopes using it re-render its label (their
        // vectors are made from it).
        const changed: { kind: TypeKind; key: string }[] = [];
        for (const type of CORE_ENTITY_TYPES) {
            const [row] = await tx
                .insert(knowledgeEntityTypes)
                .values({
                    userId: null,
                    key: type.key,
                    label: encryptText(type.label),
                    labelHmac: domainLookupHash(
                        LABEL_DOMAIN.entity,
                        type.label,
                    ),
                })
                .onConflictDoUpdate({
                    target: [
                        knowledgeEntityTypes.userId,
                        knowledgeEntityTypes.key,
                    ],
                    set: {
                        label: encryptText(type.label),
                        labelHmac: domainLookupHash(
                            LABEL_DOMAIN.entity,
                            type.label,
                        ),
                        status: "active",
                    },
                    setWhere: sql`${knowledgeEntityTypes.labelHmac} is distinct from excluded.label_hmac or ${knowledgeEntityTypes.status} <> 'active'`,
                })
                .returning({ key: knowledgeEntityTypes.key });
            if (row) changed.push({ kind: "entity", key: row.key });
        }
        for (const relation of CORE_RELATIONS) {
            const values = {
                label: encryptText(relation.label),
                labelHmac: domainLookupHash(
                    LABEL_DOMAIN.relation,
                    relation.label,
                ),
                subjectTypes: [...relation.subjectTypes],
                objectTypes: [...relation.objectTypes],
                objectKind: relation.objectKind,
                cardinality: relation.cardinality,
            };
            const [row] = await tx
                .insert(knowledgeRelationTypes)
                .values({ userId: null, key: relation.key, ...values })
                .onConflictDoUpdate({
                    target: [
                        knowledgeRelationTypes.userId,
                        knowledgeRelationTypes.key,
                    ],
                    set: { ...values, status: "active" },
                    setWhere: sql`(${knowledgeRelationTypes.labelHmac}, ${knowledgeRelationTypes.subjectTypes}, ${knowledgeRelationTypes.objectTypes}, ${knowledgeRelationTypes.objectKind}, ${knowledgeRelationTypes.cardinality}, ${knowledgeRelationTypes.status}) is distinct from (excluded.label_hmac, excluded.subject_types, excluded.object_types, excluded.object_kind, excluded.cardinality, 'active')`,
                })
                .returning({ key: knowledgeRelationTypes.key });
            if (row) changed.push({ kind: "relation", key: row.key });
        }
        if (changed.length === 0) return;
        await bumpVocabularyVersionInTx(tx);
        const scopes = new Set<string>();
        for (const { kind, key } of changed) {
            for (const scope of await scopesUsingTypeInTx(tx, kind, key)) {
                scopes.add(scope);
            }
        }
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * Seed the core vocabulary at startup. Never throws: a failed seed leaves
 * the previous core in place, and the next start tries again.
 */
export async function startCoreVocabularySeed(): Promise<void> {
    try {
        await seedCoreVocabulary();
    } catch (error) {
        console.error(
            "[vocabulary] could not seed the core vocabulary:",
            error,
        );
    }
}

function layerOf(ownerUserId: string | null, orgOwned: boolean): TypeLayer {
    if (ownerUserId === null) return "core";
    return orgOwned ? "org" : "private";
}

/**
 * The vocabulary `userId` may use: core, the Organization's, and their own
 * private types, unless `sharedOnly` (a shared recording's Learn run, which
 * reads and writes the shared layer alone). Retired types are left out.
 */
export async function vocabularyVisibleTo(
    userId: string,
    { sharedOnly = false }: { sharedOnly?: boolean } = {},
): Promise<Vocabulary> {
    const visible = (
        column:
            | typeof knowledgeEntityTypes.userId
            | typeof knowledgeRelationTypes.userId,
    ) =>
        sharedOnly
            ? or(isNull(column), orgOwnedCondition(column))
            : or(isNull(column), orgOwnedCondition(column), eq(column, userId));

    const entityRows = await db
        .select({
            key: knowledgeEntityTypes.key,
            label: knowledgeEntityTypes.label,
            userId: knowledgeEntityTypes.userId,
            adoptedAsKey: knowledgeEntityTypes.adoptedAsKey,
            orgOwned: sql<boolean>`coalesce(${orgOwnedCondition(knowledgeEntityTypes.userId)}, false)`,
        })
        .from(knowledgeEntityTypes)
        .where(
            and(
                visible(knowledgeEntityTypes.userId),
                eq(knowledgeEntityTypes.status, "active"),
            ),
        );
    const relationRows = await db
        .select({
            key: knowledgeRelationTypes.key,
            label: knowledgeRelationTypes.label,
            userId: knowledgeRelationTypes.userId,
            adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
            subjectTypes: knowledgeRelationTypes.subjectTypes,
            objectTypes: knowledgeRelationTypes.objectTypes,
            objectKind: knowledgeRelationTypes.objectKind,
            cardinality: knowledgeRelationTypes.cardinality,
            orgOwned: sql<boolean>`coalesce(${orgOwnedCondition(knowledgeRelationTypes.userId)}, false)`,
        })
        .from(knowledgeRelationTypes)
        .where(
            and(
                visible(knowledgeRelationTypes.userId),
                eq(knowledgeRelationTypes.status, "active"),
            ),
        );

    return {
        entityTypes: entityRows.map((row) => ({
            kind: "entity" as const,
            key: row.key,
            label: decryptText(row.label),
            layer: layerOf(row.userId, row.orgOwned),
            adoptedAsKey: row.adoptedAsKey,
        })),
        relationTypes: relationRows.map((row) => ({
            kind: "relation" as const,
            key: row.key,
            label: decryptText(row.label),
            layer: layerOf(row.userId, row.orgOwned),
            adoptedAsKey: row.adoptedAsKey,
            subjectTypes: row.subjectTypes,
            objectTypes: row.objectTypes,
            objectKind: row.objectKind,
            cardinality: row.cardinality,
        })),
    };
}

function cleanLabel(label: string): string {
    const clean = label.trim().replace(/\s+/g, " ");
    if (!clean) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A type needs a name",
            400,
            {
                field: "label",
            },
        );
    }
    if (clean.length > MAX_TYPE_LABEL_LENGTH) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `A type's name must be ${MAX_TYPE_LABEL_LENGTH} characters or fewer`,
            400,
            { field: "label", maxLength: MAX_TYPE_LABEL_LENGTH },
        );
    }
    const denied = deniedTopicOf(clean);
    if (denied) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Knowledge about people's health, family, personality, performance or demographics is not kept",
            400,
            { field: "label", deniedTopic: denied.id },
        );
    }
    return clean;
}

/**
 * Refuse a label the owner already uses, or one the core or Organization
 * vocabulary has: that type is there to use. Asked only about the layers
 * the owner can see, so the answer reveals nobody else's private types.
 */
async function assertLabelFree(
    tx: Tx,
    kind: TypeKind,
    ownerUserId: string,
    labelHmac: string,
    exceptKey?: string,
): Promise<void> {
    const table = tableOf(kind);
    const [taken] = await tx
        .select({ key: table.key })
        .from(table)
        .where(
            and(
                eq(table.labelHmac, labelHmac),
                or(
                    isNull(table.userId),
                    orgOwnedCondition(table.userId),
                    eq(table.userId, ownerUserId),
                ),
                eq(table.status, "active"),
            ),
        )
        .limit(1);
    if (taken && taken.key !== exceptKey) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "A type with this name already exists",
            409,
            { field: "label" },
        );
    }
}

/**
 * Entity type keys `ownerUserId` may relate: core, the Organization's, and
 * theirs; refused if any given one is not among them.
 */
async function assertEntityTypesUsable(
    tx: Tx,
    ownerUserId: string,
    keys: readonly string[],
): Promise<void> {
    if (keys.length === 0) return;
    const rows = await tx
        .select({ key: knowledgeEntityTypes.key })
        .from(knowledgeEntityTypes)
        .where(
            and(
                inArray(knowledgeEntityTypes.key, [...keys]),
                or(
                    isNull(knowledgeEntityTypes.userId),
                    orgOwnedCondition(knowledgeEntityTypes.userId),
                    eq(knowledgeEntityTypes.userId, ownerUserId),
                ),
                eq(knowledgeEntityTypes.status, "active"),
            ),
        );
    const found = new Set(rows.map((row) => row.key));
    if (keys.some((key) => !found.has(key))) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Unknown entity type",
            400,
            { field: "types" },
        );
    }
}

export type NewTypeSpec =
    | { kind: "entity"; label: string }
    | {
          kind: "relation";
          label: string;
          subjectTypes: string[];
          objectTypes: string[];
          objectKind: "entity" | "literal";
          cardinality: "one" | "many";
      };

async function insertTypeInTx(
    tx: Tx,
    ownerUserId: string,
    actorUserId: string,
    keyPrefix: "u" | "o",
    spec: NewTypeSpec,
): Promise<string> {
    const label = cleanLabel(spec.label);
    const labelHmac = domainLookupHash(LABEL_DOMAIN[spec.kind], label);
    await assertLabelFree(tx, spec.kind, ownerUserId, labelHmac);
    const key = `${keyPrefix}_${nanoid(12)}`;
    if (spec.kind === "entity") {
        await tx.insert(knowledgeEntityTypes).values({
            userId: ownerUserId,
            key,
            label: encryptText(label),
            labelHmac,
            createdByUserId: actorUserId,
        });
    } else {
        await assertEntityTypesUsable(tx, ownerUserId, [
            ...spec.subjectTypes,
            ...spec.objectTypes,
        ]);
        if (spec.subjectTypes.length === 0) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "A relation needs the kinds of things it relates",
                400,
                { field: "subjectTypes" },
            );
        }
        if (
            (spec.objectKind === "literal") !==
            (spec.objectTypes.length === 0)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "A relation to text has no object types, and one to things has some",
                400,
                { field: "objectTypes" },
            );
        }
        await tx.insert(knowledgeRelationTypes).values({
            userId: ownerUserId,
            key,
            label: encryptText(label),
            labelHmac,
            subjectTypes: [...new Set(spec.subjectTypes)],
            objectTypes: [...new Set(spec.objectTypes)],
            objectKind: spec.objectKind,
            cardinality: spec.cardinality,
            createdByUserId: actorUserId,
        });
    }
    await bumpVocabularyVersionInTx(tx);
    return key;
}

function organizationOnly(): AppError {
    return new AppError(
        ErrorCode.FORBIDDEN,
        "Only the organization account changes the Organization's vocabulary",
        403,
    );
}

function typeNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Type not found", 404);
}

/** Create one of the user's private types. Returns its key. */
export async function createPrivateType(
    userId: string,
    spec: NewTypeSpec,
): Promise<string> {
    // The organization account's types are the Organization's.
    if (await isOrgAccount(userId)) throw organizationOnly();
    return db.transaction(async (tx) => {
        const key = await insertTypeInTx(tx, userId, userId, "u", spec);
        await bumpScopeInTx(tx, [userId]);
        return key;
    });
}

/** Create an Organization type. The organization account only. */
export async function createOrgType(
    actorUserId: string,
    spec: NewTypeSpec,
): Promise<string> {
    if (!(await isOrgAccount(actorUserId))) throw organizationOnly();
    return db.transaction(async (tx) => {
        const key = await insertTypeInTx(
            tx,
            actorUserId,
            actorUserId,
            "o",
            spec,
        );
        await bumpScopeInTx(tx, [actorUserId]);
        return key;
    });
}

/**
 * The owner's own active type of a kind, locked for a change, or 404. Core
 * types and other accounts' types answer the same, so nothing reveals them.
 */
async function lockOwnType(
    tx: Tx,
    kind: TypeKind,
    ownerUserId: string,
    key: string,
): Promise<{ id: string }> {
    const table = tableOf(kind);
    const [row] = await tx
        .select({ id: table.id })
        .from(table)
        .where(
            and(
                eq(table.userId, ownerUserId),
                eq(table.key, key),
                eq(table.status, "active"),
            ),
        )
        .for("update")
        .limit(1);
    if (!row) throw typeNotFound();
    return row;
}

/** Rename one of the user's own types (private, or the Organization's by its account). */
export async function renameOwnType(
    userId: string,
    kind: TypeKind,
    key: string,
    newLabel: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        const { id } = await lockOwnType(tx, kind, userId, key);
        const label = cleanLabel(newLabel);
        const labelHmac = domainLookupHash(LABEL_DOMAIN[kind], label);
        await assertLabelFree(tx, kind, userId, labelHmac, key);
        const table = tableOf(kind);
        await tx
            .update(table)
            .set({
                label: encryptText(label),
                labelHmac,
                updatedAt: new Date(),
            })
            .where(eq(table.id, id));
        await bumpVocabularyVersionInTx(tx);
        // Everyone whose entities or facts read with the old name.
        await bumpScopeInTx(tx, [
            userId,
            ...(await scopesUsingTypeInTx(tx, kind, key)),
        ]);
    });
}

/**
 * What goes with a type when its owner deletes it: their entities of an
 * entity type (with everything naming them), or their facts of a relation
 * type (with their evidence).
 *
 * Only the owner's: another account's private entities or facts of an
 * Organization type keep its key, and are theirs to change.
 */
function usesOfTypeCondition(kind: TypeKind, ownerUserId: string, key: string) {
    return kind === "entity"
        ? and(
              eq(knowledgeEntities.userId, ownerUserId),
              eq(knowledgeEntities.typeKey, key),
          )
        : and(
              eq(knowledgeFacts.userId, ownerUserId),
              eq(knowledgeFacts.relationKey, key),
          );
}

async function usesOfType(
    tx: Tx,
    kind: TypeKind,
    ownerUserId: string,
    key: string,
): Promise<number> {
    const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(kind === "entity" ? knowledgeEntities : knowledgeFacts)
        .where(usesOfTypeCondition(kind, ownerUserId, key));
    return row?.count ?? 0;
}

/**
 * Delete one of the user's own types and what uses it (`usesOfType`).
 * `confirmCount` must be the number the person was shown; any other number
 * is refused (409, `details.count`), so nothing is deleted that the person
 * did not see counted.
 *
 * An Organization type reaches further than its count, which stays the
 * Organization's own so the curator never learns how much members know
 * privately (Johnny, 2026-09-28); the confirmation says so in words:
 * - with its entities goes everything anyone knows about them (their
 *   facts, aliases, notes and corrections, in every scope);
 * - a relation type goes from every member's facts: a member whose own
 *   type had been adopted as it gets that type back, with the facts they
 *   stated since (combined where they say the same); other members'
 *   facts with it go;
 * - private types adopted as it are adopted no longer.
 *
 * Like deleting a person or an entity, it takes the Organization-people
 * lock and then the recordings a transcript rewrite would lock, of every
 * transcript whose corrections or evidence go with it.
 */
export async function deleteOwnType(
    userId: string,
    kind: TypeKind,
    key: string,
    confirmCount: number,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const { id } = await lockOwnType(tx, kind, userId, key);
        const count = await usesOfType(tx, kind, userId, key);
        if (count !== confirmCount) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The number of things using this type has changed",
                409,
                { count },
            );
        }
        // Read before the delete: the owner's entities of the type take
        // everyone's aliases, notes, facts and corrections naming them.
        const scopes = await scopesUsingTypeInTx(tx, kind, key);
        scopes.add(userId);
        const organization = await isOrgAccount(userId);
        if (kind === "relation") {
            const facts = await tx
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(
                    organization
                        ? eq(knowledgeFacts.relationKey, key)
                        : usesOfTypeCondition(kind, userId, key),
                );
            await lockRecordingsNaming(tx, {
                factIds: facts.map((row) => row.id),
            });
        }
        if (organization) {
            const table = tableOf(kind);
            const adopters = await tx
                .update(table)
                .set({ adoptedAsKey: null, updatedAt: new Date() })
                .where(
                    and(
                        eq(table.adoptedAsKey, key),
                        sql`${table.userId} is not null`,
                    ),
                )
                .returning({ userId: table.userId, key: table.key });
            for (const adopter of adopters) {
                if (!adopter.userId) continue;
                scopes.add(adopter.userId);
                if (kind === "relation") {
                    // What the member stated with the Organization's shape
                    // and their own type does not take goes; the rest
                    // returns to their type.
                    await deleteFactsInTx(
                        tx,
                        await factsNotFittingInTx(tx, {
                            userId: adopter.userId,
                            relationKey: key,
                            shapeKey: adopter.key,
                        }),
                    );
                    await rekeyRelationInTx(tx, {
                        userId: adopter.userId,
                        from: key,
                        to: adopter.key,
                    });
                }
            }
            if (kind === "relation") {
                const left = await tx
                    .select({ id: knowledgeFacts.id })
                    .from(knowledgeFacts)
                    .where(
                        and(
                            eq(knowledgeFacts.relationKey, key),
                            ne(knowledgeFacts.userId, userId),
                        ),
                    );
                await deleteFactsInTx(
                    tx,
                    left.map((row) => row.id),
                );
            }
        }
        if (kind === "entity" && count > 0) {
            const doomed = await tx
                .select({ id: knowledgeEntities.id })
                .from(knowledgeEntities)
                .where(usesOfTypeCondition(kind, userId, key));
            await lockRecordingsNaming(tx, {
                entityIds: doomed.map((row) => row.id),
            });
            for (const scope of await scopesNamingInTx(tx, {
                entityIds: doomed.map((row) => row.id),
            })) {
                scopes.add(scope);
            }
            // Before the cascade would, keeping chains whole.
            await deleteFactsNamingInTx(tx, {
                entityIds: doomed.map((row) => row.id),
            });
        }
        if (count > 0) {
            await tx
                .delete(kind === "entity" ? knowledgeEntities : knowledgeFacts)
                .where(usesOfTypeCondition(kind, userId, key));
        }
        const table = tableOf(kind);
        await tx.delete(table).where(eq(table.id, id));
        await bumpVocabularyVersionInTx(tx);
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * The ids of `userId`'s facts of `relationKey` that the relation type
 * `shapeKey` (theirs) does not take (`relationFits`).
 */
async function factsNotFittingInTx(
    tx: Tx,
    {
        userId,
        relationKey,
        shapeKey,
    }: { userId: string; relationKey: string; shapeKey: string },
): Promise<string[]> {
    const [shape] = await tx
        .select({
            subjectTypes: knowledgeRelationTypes.subjectTypes,
            objectTypes: knowledgeRelationTypes.objectTypes,
            objectKind: knowledgeRelationTypes.objectKind,
        })
        .from(knowledgeRelationTypes)
        .where(
            and(
                eq(knowledgeRelationTypes.userId, userId),
                eq(knowledgeRelationTypes.key, shapeKey),
            ),
        )
        .limit(1);
    const facts = await tx
        .select({
            id: knowledgeFacts.id,
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
        })
        .from(knowledgeFacts)
        .where(
            and(
                eq(knowledgeFacts.userId, userId),
                eq(knowledgeFacts.relationKey, relationKey),
            ),
        );
    if (!shape) return facts.map((fact) => fact.id);
    const entityIds = facts.flatMap((fact) =>
        [fact.subjectEntityId, fact.objectEntityId].filter(
            (id): id is string => id !== null,
        ),
    );
    const types = new Map(
        entityIds.length > 0
            ? (
                  await tx
                      .select({
                          id: knowledgeEntities.id,
                          typeKey: knowledgeEntities.typeKey,
                      })
                      .from(knowledgeEntities)
                      .where(inArray(knowledgeEntities.id, entityIds))
              ).map((row) => [row.id, row.typeKey])
            : [],
    );
    const typeOf = (personId: string | null, entityId: string | null) =>
        personId ? "person" : (types.get(entityId ?? "") ?? "");
    return facts
        .filter(
            (fact) =>
                !relationFits(
                    {
                        subjectTypes: shape.subjectTypes,
                        objectTypes: shape.objectTypes,
                        objectKind: shape.objectKind,
                    },
                    typeOf(fact.subjectPersonId, fact.subjectEntityId),
                    fact.objectPersonId || fact.objectEntityId
                        ? {
                              type: typeOf(
                                  fact.objectPersonId,
                                  fact.objectEntityId,
                              ),
                          }
                        : { literal: true },
                ),
        )
        .map((fact) => fact.id);
}

/**
 * Suggest a relation phrase to the Organization. Only the phrase travels,
 * counted once per user; suggesting it again changes nothing.
 */
export async function proposePhrase(
    userId: string,
    phrase: string,
): Promise<void> {
    const clean = cleanLabel(phrase);
    const phraseHmac = domainLookupHash(PHRASE_DOMAIN, clean);
    await db.transaction(async (tx) => {
        const [proposal] = await tx
            .insert(knowledgeVocabularyProposals)
            .values({ phrase: encryptText(clean), phraseHmac })
            .onConflictDoUpdate({
                target: knowledgeVocabularyProposals.phraseHmac,
                // A no-op write, so the row comes back either way.
                set: { phraseHmac },
            })
            .returning({ id: knowledgeVocabularyProposals.id });
        if (!proposal) return;
        await tx
            .insert(knowledgeVocabularyProposalVotes)
            .values({ proposalId: proposal.id, userId })
            .onConflictDoNothing();
    });
}

export interface VocabularyProposal {
    id: string;
    phrase: string;
    count: number;
    status: "open" | "adopted" | "rejected";
}

/**
 * The suggested phrases, most frequent first. The organization account
 * only. An open phrase nobody stands behind any more (its voters' accounts
 * are gone) is left out.
 */
export async function listVocabularyProposals(
    actorUserId: string,
): Promise<VocabularyProposal[]> {
    if (!(await isOrgAccount(actorUserId))) throw organizationOnly();
    const count = sql<number>`count(${knowledgeVocabularyProposalVotes.userId})::int`;
    const rows = await db
        .select({
            id: knowledgeVocabularyProposals.id,
            phrase: knowledgeVocabularyProposals.phrase,
            count,
            status: knowledgeVocabularyProposals.status,
        })
        .from(knowledgeVocabularyProposals)
        .leftJoin(
            knowledgeVocabularyProposalVotes,
            eq(
                knowledgeVocabularyProposalVotes.proposalId,
                knowledgeVocabularyProposals.id,
            ),
        )
        .groupBy(knowledgeVocabularyProposals.id)
        .having(
            sql`${count} > 0 or ${knowledgeVocabularyProposals.status} <> 'open'`,
        )
        .orderBy(desc(count));
    return rows.map((row) => ({ ...row, phrase: decryptText(row.phrase) }));
}

/**
 * Adopt a suggested phrase as an Organization relation type. Private
 * relation types of the same name record the new key (`adoptedAsKey`), so
 * their owners' later facts use the shared one. Returns the new key.
 */
export async function adoptPhrase(
    actorUserId: string,
    proposalId: string,
    spec: Omit<Extract<NewTypeSpec, { kind: "relation" }>, "kind" | "label"> & {
        label?: string;
    },
): Promise<string> {
    if (!(await isOrgAccount(actorUserId))) throw organizationOnly();
    return db.transaction(async (tx) => {
        const [proposal] = await tx
            .select({
                phrase: knowledgeVocabularyProposals.phrase,
                status: knowledgeVocabularyProposals.status,
            })
            .from(knowledgeVocabularyProposals)
            .where(eq(knowledgeVocabularyProposals.id, proposalId))
            .for("update")
            .limit(1);
        if (!proposal || proposal.status !== "open") {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Suggestion not found",
                404,
            );
        }
        const label = spec.label ?? decryptText(proposal.phrase);
        const key = await insertTypeInTx(tx, actorUserId, actorUserId, "o", {
            kind: "relation",
            label,
            subjectTypes: spec.subjectTypes,
            objectTypes: spec.objectTypes,
            objectKind: spec.objectKind,
            cardinality: spec.cardinality,
        });
        await tx
            .update(knowledgeVocabularyProposals)
            .set({
                status: "adopted",
                adoptedAsKey: key,
                updatedAt: new Date(),
            })
            .where(eq(knowledgeVocabularyProposals.id, proposalId));
        const labelHmac = domainLookupHash(
            LABEL_DOMAIN.relation,
            cleanLabel(label),
        );
        const adopters = await tx
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: key, updatedAt: new Date() })
            .where(
                and(
                    eq(knowledgeRelationTypes.labelHmac, labelHmac),
                    sql`${knowledgeRelationTypes.userId} is not null`,
                    sql`not ${orgOwnedCondition(knowledgeRelationTypes.userId)}`,
                ),
            )
            .returning({ userId: knowledgeRelationTypes.userId });
        await bumpScopeInTx(tx, [
            actorUserId,
            ...adopters.map((row) => row.userId),
        ]);
        return key;
    });
}
