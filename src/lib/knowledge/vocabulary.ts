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

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import { foldEntityInTx } from "@/lib/knowledge/entities";
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
        )
        // Held until the new type is in: a merge or delete taking one of
        // them waits, then finds the new type relating it. In id order, as
        // merges and shares take them.
        .orderBy(asc(knowledgeEntityTypes.id))
        .for("share");
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
    { bumpVersion = true }: { bumpVersion?: boolean } = {},
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
    if (bumpVersion) await bumpVocabularyVersionInTx(tx);
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

/**
 * A new type of the actor's own, inside a caller's transaction, which
 * checked who the actor is and bumps the vocabulary's version and their
 * scope once, last (a finished review): a private type for a member, an
 * Organization type for the organization account. Returns its key.
 *
 * The version is the caller's to bump: held from the first type on, it
 * would be taken before the type rows the next one relates, which a rename
 * takes the other way round.
 */
export async function createOwnTypeInTx(
    tx: Tx,
    actorUserId: string,
    organization: boolean,
    spec: NewTypeSpec,
): Promise<string> {
    return insertTypeInTx(
        tx,
        actorUserId,
        actorUserId,
        organization ? "o" : "u",
        spec,
        { bumpVersion: false },
    );
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
                // Named by its owner now, so no longer only as a share made it.
                adoptedFromShare: false,
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

/** One of an account's own types, as it tends them (`listOwnTypes`). */
export type OwnType = {
    key: string;
    label: string;
    /** Made by a share from a member's type, not yet kept, renamed or merged. */
    adoptedFromShare: boolean;
    /** The account's own entities of it, or facts with it. */
    uses: number;
} & (
    | { kind: "entity" }
    | {
          kind: "relation";
          shape: {
              subjectTypes: string[];
              objectTypes: string[];
              objectKind: "entity" | "literal";
              cardinality: "one" | "many";
          };
      }
);

/**
 * The account's own active types (a member's private ones, the
 * Organization's for its account), those a share adopted first, then by
 * name, each with how much of its own knowledge uses it.
 */
export async function listOwnTypes(userId: string): Promise<OwnType[]> {
    const entityRows = await db
        .select({
            key: knowledgeEntityTypes.key,
            label: knowledgeEntityTypes.label,
            adoptedFromShare: knowledgeEntityTypes.adoptedFromShare,
            uses: sql<number>`(select count(*)::int from ${knowledgeEntities} where ${knowledgeEntities.userId} = ${userId} and ${knowledgeEntities.typeKey} = ${knowledgeEntityTypes.key} and ${knowledgeEntities.mergedIntoId} is null)`,
        })
        .from(knowledgeEntityTypes)
        .where(
            and(
                eq(knowledgeEntityTypes.userId, userId),
                eq(knowledgeEntityTypes.status, "active"),
            ),
        );
    const relationRows = await db
        .select({
            key: knowledgeRelationTypes.key,
            label: knowledgeRelationTypes.label,
            adoptedFromShare: knowledgeRelationTypes.adoptedFromShare,
            subjectTypes: knowledgeRelationTypes.subjectTypes,
            objectTypes: knowledgeRelationTypes.objectTypes,
            objectKind: knowledgeRelationTypes.objectKind,
            cardinality: knowledgeRelationTypes.cardinality,
            uses: sql<number>`(select count(*)::int from ${knowledgeFacts} where ${knowledgeFacts.userId} = ${userId} and ${knowledgeFacts.relationKey} = ${knowledgeRelationTypes.key})`,
        })
        .from(knowledgeRelationTypes)
        .where(
            and(
                eq(knowledgeRelationTypes.userId, userId),
                eq(knowledgeRelationTypes.status, "active"),
            ),
        );
    const types: OwnType[] = [
        ...entityRows.map((row) => ({
            kind: "entity" as const,
            key: row.key,
            label: decryptText(row.label),
            adoptedFromShare: row.adoptedFromShare,
            uses: row.uses,
        })),
        ...relationRows.map((row) => ({
            kind: "relation" as const,
            key: row.key,
            label: decryptText(row.label),
            adoptedFromShare: row.adoptedFromShare,
            uses: row.uses,
            shape: {
                subjectTypes: row.subjectTypes,
                objectTypes: row.objectTypes,
                objectKind: row.objectKind,
                cardinality: row.cardinality,
            },
        })),
    ];
    return types.sort(
        (a, b) =>
            Number(b.adoptedFromShare) - Number(a.adoptedFromShare) ||
            a.label.localeCompare(b.label),
    );
}

/** Keep a type a share adopted as it is: it is no longer marked. */
export async function keepAdoptedType(
    userId: string,
    kind: TypeKind,
    key: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        const { id } = await lockOwnType(tx, kind, userId, key);
        const table = tableOf(kind);
        await tx
            .update(table)
            .set({ adoptedFromShare: false, updatedAt: new Date() })
            .where(eq(table.id, id));
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
    // Entities merged away go too, but were counted where they were
    // merged: the person counts the ones they see.
    const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(kind === "entity" ? knowledgeEntities : knowledgeFacts)
        .where(
            kind === "entity"
                ? and(
                      usesOfTypeCondition(kind, ownerUserId, key),
                      isNull(knowledgeEntities.mergedIntoId),
                  )
                : usesOfTypeCondition(kind, ownerUserId, key),
        );
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
 *   facts, aliases, notes and corrections, in every scope), and so do
 *   members' own entities of it, with what they know about those;
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
        // Of an entity type, the relation types relating it lose it: the
        // type rows, in id order, before anything else.
        const relating =
            kind === "entity" ? await relationTypesRelatingInTx(tx, key) : [];
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
        // An Organization entity type takes every account's entities of it
        // (Johnny, 2026-09-29): a member's entity of a type that is gone
        // has nothing to be. Counted as the Organization's own only.
        const entitiesGoing =
            kind === "entity" && organization
                ? eq(knowledgeEntities.typeKey, key)
                : usesOfTypeCondition(kind, userId, key);
        if (kind === "entity") {
            const doomed = await tx
                .select({ id: knowledgeEntities.id })
                .from(knowledgeEntities)
                .where(entitiesGoing);
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
        if (kind === "entity") {
            await tx.delete(knowledgeEntities).where(entitiesGoing);
        } else if (count > 0) {
            await tx
                .delete(knowledgeFacts)
                .where(usesOfTypeCondition(kind, userId, key));
        }
        const table = tableOf(kind);
        for (const scope of await dropFromRelationShapesInTx(
            tx,
            relating,
            key,
        )) {
            scopes.add(scope);
        }
        await tx.delete(table).where(eq(table.id, id));
        await bumpVocabularyVersionInTx(tx);
        await bumpScopeInTx(tx, scopes);
    });
}

type RelatingRow = {
    id: string;
    key: string;
    userId: string | null;
    subjectTypes: string[];
    objectTypes: string[];
    objectKind: "entity" | "literal";
};

/**
 * Every account's relation types relating entity type `key`, locked in id
 * order: a merge or delete of the entity type rewrites their shapes.
 */
async function relationTypesRelatingInTx(
    tx: Tx,
    key: string,
): Promise<RelatingRow[]> {
    return tx
        .select({
            id: knowledgeRelationTypes.id,
            key: knowledgeRelationTypes.key,
            userId: knowledgeRelationTypes.userId,
            subjectTypes: knowledgeRelationTypes.subjectTypes,
            objectTypes: knowledgeRelationTypes.objectTypes,
            objectKind: knowledgeRelationTypes.objectKind,
        })
        .from(knowledgeRelationTypes)
        .where(
            sql`${knowledgeRelationTypes.subjectTypes} ? ${key} or ${knowledgeRelationTypes.objectTypes} ? ${key}`,
        )
        .orderBy(asc(knowledgeRelationTypes.id))
        .for("update");
}

/**
 * Take a deleted entity type out of the shapes of the relation types
 * relating it, so none names a type that is gone (which a share would
 * never adopt). One left relating nothing on a side goes: its facts went
 * with the entities of the type, and types adopted as it are adopted no
 * longer. Returns the scopes whose vocabulary changed.
 */
async function dropFromRelationShapesInTx(
    tx: Tx,
    relating: readonly RelatingRow[],
    key: string,
): Promise<Set<string>> {
    const scopes = new Set<string>();
    for (const relation of relating) {
        if (relation.userId) scopes.add(relation.userId);
        const subjectTypes = relation.subjectTypes.filter((k) => k !== key);
        const objectTypes = relation.objectTypes.filter((k) => k !== key);
        const empty =
            subjectTypes.length === 0 ||
            (relation.objectKind === "entity" && objectTypes.length === 0);
        if (!empty) {
            await tx
                .update(knowledgeRelationTypes)
                .set({ subjectTypes, objectTypes, updatedAt: new Date() })
                .where(eq(knowledgeRelationTypes.id, relation.id));
            continue;
        }
        const left = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.relationKey, relation.key));
        await deleteFactsInTx(
            tx,
            left.map((row) => row.id),
        );
        const adopters = await tx
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: null, updatedAt: new Date() })
            .where(eq(knowledgeRelationTypes.adoptedAsKey, relation.key))
            .returning({ userId: knowledgeRelationTypes.userId });
        for (const adopter of adopters) {
            if (adopter.userId) scopes.add(adopter.userId);
        }
        await tx
            .delete(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.id, relation.id));
    }
    return scopes;
}

/**
 * What a merge of `from` into `into` changes beyond their keys, per owner:
 * of a relation type, the facts `into` does not take, which go; of an
 * entity type, the entities an owner already has of `into` under the same
 * name (`folds`: the one that goes, and the one it joins).
 */
type MergePlan =
    | { kind: "relation"; dropping: Map<string, string[]> }
    | {
          kind: "entity";
          folds: { userId: string; loserId: string; winnerId: string }[];
      };

async function planTypeMergeInTx(
    tx: Tx,
    kind: TypeKind,
    from: string,
    into: string,
): Promise<MergePlan> {
    if (kind === "relation") {
        const owners = await tx
            .selectDistinct({ userId: knowledgeFacts.userId })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.relationKey, from));
        const dropping = new Map<string, string[]>();
        for (const { userId } of owners) {
            dropping.set(
                userId,
                await factsNotFittingInTx(tx, {
                    userId,
                    relationKey: from,
                    shapeKey: into,
                }),
            );
        }
        return { kind, dropping };
    }
    const same = alias(knowledgeEntities, "same");
    const folds = await tx
        .select({
            userId: knowledgeEntities.userId,
            loserId: knowledgeEntities.id,
            winnerId: same.id,
        })
        .from(knowledgeEntities)
        .innerJoin(
            same,
            and(
                eq(same.userId, knowledgeEntities.userId),
                eq(same.nameHmac, knowledgeEntities.nameHmac),
                eq(same.typeKey, into),
                isNull(same.mergedIntoId),
            ),
        )
        .where(
            and(
                eq(knowledgeEntities.typeKey, from),
                isNull(knowledgeEntities.mergedIntoId),
            ),
        );
    return { kind, folds };
}

/** How many of the owner's own things a merge changes (`mergeOwnTypes`). */
function mergeCountOf(plan: MergePlan, userId: string): number {
    return plan.kind === "relation"
        ? (plan.dropping.get(userId)?.length ?? 0)
        : plan.folds.filter((fold) => fold.userId === userId).length;
}

/**
 * `from`, the owner's own active type, and `into`, another of the kind that
 * is theirs or the core's; 404 otherwise, as for a type they do not have.
 * Locked in id order when `lock`.
 */
async function mergeableTypesInTx(
    tx: Tx,
    userId: string,
    kind: TypeKind,
    from: string,
    into: string,
    lock: boolean,
): Promise<{ from: MergeableRow; into: MergeableRow }> {
    if (from === into) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A type cannot be merged into itself",
            400,
            { field: "into" },
        );
    }
    // People are not entities (`assertTypeUsable`): an entity of type
    // person would split one human in two.
    if (kind === "entity" && into === "person") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Entities cannot become people",
            400,
            { field: "into" },
        );
    }
    const table = tableOf(kind);
    const query = tx
        .select({
            key: table.key,
            userId: table.userId,
            adoptedAsKey: table.adoptedAsKey,
        })
        .from(table)
        .where(
            and(
                inArray(table.key, [from, into]),
                or(eq(table.userId, userId), isNull(table.userId)),
                eq(table.status, "active"),
            ),
        )
        .orderBy(asc(table.id));
    const rows = lock ? await query.for("update") : await query;
    const fromRow = rows.find((row) => row.key === from);
    const intoRow = rows.find((row) => row.key === into);
    if (!fromRow || fromRow.userId !== userId || !intoRow) {
        throw typeNotFound();
    }
    return { from: fromRow, into: intoRow };
}

type MergeableRow = {
    key: string;
    userId: string | null;
    adoptedAsKey: string | null;
};

/**
 * How many of the account's own things merging `from` into `into` changes:
 * the number `mergeOwnTypes` asks to be confirmed.
 */
export async function typeMergeCount(
    userId: string,
    kind: TypeKind,
    from: string,
    into: string,
): Promise<number> {
    return db.transaction(async (tx) => {
        await mergeableTypesInTx(tx, userId, kind, from, into, false);
        return mergeCountOf(
            await planTypeMergeInTx(tx, kind, from, into),
            userId,
        );
    });
}

/**
 * Merge one of the account's own types (`from`) into another of the same
 * kind, its own or a core one (`into`): whatever used `from` uses `into`,
 * and `from` goes. The curator tidies the types shares adopted this way
 * (Johnny, 2026-09-29).
 *
 * Of a relation type, every account's facts of it move to `into`,
 * combined where they then say the same; those `into` does not take go.
 * Of an entity type, every account's entities of it take `into`, an
 * entity joining one of `into` its owner has under the same name (as
 * merging two entities does), and the relation types relating `from`
 * relate `into` instead. Types adopted as `from` are adopted as `into`.
 *
 * `confirmCount` must be what `typeMergeCount` showed: the account's own
 * facts that go, or its own entities that join another; any other number
 * is refused (409, `details.count`). As on deleting, members' are not
 * counted, so the curator never learns how much members know privately.
 *
 * Locks as deleting does: the Organization-people lock, both type rows
 * (in id order) and the relation types relating `from`, the recordings
 * whose corrections or evidence move, then the vocabulary's version and
 * the scopes.
 */
export async function mergeOwnTypes(
    userId: string,
    kind: TypeKind,
    from: string,
    into: string,
    confirmCount: number,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const rows = await mergeableTypesInTx(
            tx,
            userId,
            kind,
            from,
            into,
            true,
        );
        const relating =
            kind === "entity" ? await relationTypesRelatingInTx(tx, from) : [];
        const plan = await planTypeMergeInTx(tx, kind, from, into);
        const count = mergeCountOf(plan, userId);
        if (count !== confirmCount) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The number of things this merge changes has changed",
                409,
                { count },
            );
        }
        const scopes = await scopesUsingTypeInTx(tx, kind, from);
        scopes.add(userId);

        if (plan.kind === "relation") {
            const facts = await tx
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.relationKey, from));
            await lockRecordingsNaming(tx, {
                factIds: facts.map((row) => row.id),
            });
            for (const [owner, ids] of plan.dropping) {
                await deleteFactsInTx(tx, ids);
                await rekeyRelationInTx(tx, { userId: owner, from, to: into });
            }
        } else {
            const entities = await tx
                .select({ id: knowledgeEntities.id })
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.typeKey, from));
            const entityIds = [
                ...entities.map((row) => row.id),
                ...plan.folds.map((fold) => fold.winnerId),
            ];
            await lockRecordingsNaming(tx, { entityIds });
            for (const scope of await scopesNamingInTx(tx, { entityIds })) {
                scopes.add(scope);
            }
            for (const fold of plan.folds) {
                await foldEntityInTx(tx, fold.winnerId, fold.loserId);
            }
            // Tombstones too, so nothing is left of a type that is gone.
            await tx
                .update(knowledgeEntities)
                .set({ typeKey: into, updatedAt: new Date() })
                .where(eq(knowledgeEntities.typeKey, from));
            const retyped = (keys: readonly string[]) => [
                ...new Set(keys.map((key) => (key === from ? into : key))),
            ];
            for (const relation of relating) {
                await tx
                    .update(knowledgeRelationTypes)
                    .set({
                        subjectTypes: retyped(relation.subjectTypes),
                        objectTypes: retyped(relation.objectTypes),
                        updatedAt: new Date(),
                    })
                    .where(eq(knowledgeRelationTypes.id, relation.id));
            }
        }

        const table = tableOf(kind);
        const adopters = await tx
            .update(table)
            .set({ adoptedAsKey: into, updatedAt: new Date() })
            .where(eq(table.adoptedAsKey, from))
            .returning({ userId: table.userId });
        for (const adopter of adopters) {
            if (adopter.userId) scopes.add(adopter.userId);
        }
        if (kind === "relation") {
            await tx
                .update(knowledgeVocabularyProposals)
                .set({ adoptedAsKey: into, updatedAt: new Date() })
                .where(eq(knowledgeVocabularyProposals.adoptedAsKey, from));
        }
        // A member's type the Organization adopted: what they stated with it
        // since is stored under the Organization's key, and comes back to
        // `into` should the Organization delete that type, as it would
        // have come back to `from`.
        if (
            rows.from.adoptedAsKey &&
            rows.into.userId === userId &&
            !rows.into.adoptedAsKey
        ) {
            await tx
                .update(table)
                .set({
                    adoptedAsKey: rows.from.adoptedAsKey,
                    updatedAt: new Date(),
                })
                .where(and(eq(table.userId, userId), eq(table.key, into)));
        }
        await tx
            .delete(table)
            .where(and(eq(table.userId, userId), eq(table.key, from)));
        await bumpVocabularyVersionInTx(tx);
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * The ids of `userId`'s facts of `relationKey` that the relation type
 * `shapeKey` (theirs, the Organization's or the core's) does not take
 * (`relationFits`).
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
                eq(knowledgeRelationTypes.key, shapeKey),
                or(
                    eq(knowledgeRelationTypes.userId, userId),
                    isNull(knowledgeRelationTypes.userId),
                    orgOwnedCondition(knowledgeRelationTypes.userId),
                ),
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
    await db.transaction((tx) => proposePhraseInTx(tx, userId, phrase));
}

/** `proposePhrase` inside a caller's transaction (a finished review). */
export async function proposePhraseInTx(
    tx: Tx,
    userId: string,
    phrase: string,
): Promise<void> {
    const clean = cleanLabel(phrase);
    const phraseHmac = domainLookupHash(PHRASE_DOMAIN, clean);
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
        // A merge of an entity type the new one relates takes the type rows
        // in the other order: one waits for the other here.
        await lockOrgPeople(tx);
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
        const labelHmac = domainLookupHash(
            LABEL_DOMAIN.relation,
            cleanLabel(label),
        );
        // The members' types of that name first, as renaming or deleting
        // one takes it before the vocabulary's version: the type rows,
        // then the version, then the scopes.
        const adopters = await tx
            .select({
                id: knowledgeRelationTypes.id,
                userId: knowledgeRelationTypes.userId,
            })
            .from(knowledgeRelationTypes)
            .where(
                and(
                    eq(knowledgeRelationTypes.labelHmac, labelHmac),
                    sql`${knowledgeRelationTypes.userId} is not null`,
                    sql`not ${orgOwnedCondition(knowledgeRelationTypes.userId)}`,
                ),
            )
            .orderBy(asc(knowledgeRelationTypes.id))
            .for("update");
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
        if (adopters.length > 0) {
            await tx
                .update(knowledgeRelationTypes)
                .set({ adoptedAsKey: key, updatedAt: new Date() })
                .where(
                    inArray(
                        knowledgeRelationTypes.id,
                        adopters.map((row) => row.id),
                    ),
                );
        }
        await bumpScopeInTx(tx, [
            actorUserId,
            ...adopters.map((row) => row.userId),
        ]);
        return key;
    });
}

/**
 * The owner's private types a share needs, adopted by the Organization
 * (Johnny, 2026-09-29), so what the share names is published rather than
 * left private: the entity types of the entities it names, the relation
 * types of the facts it states, and the entity types those relate.
 *
 * Each takes a core or Organization type of the same name and shape where
 * one exists; otherwise a copy the curator finds marked
 * (`adoptedFromShare`), named apart ("supplies (2)") where its name is
 * taken by a type of another shape. The owner's type records it
 * (`adoptedAsKey`), as a manual adoption does. A type already adopted as
 * one the Organization still has stays as it is.
 *
 * Inside the share's transaction, under the Organization-people lock: the
 * owner's type rows first, then the vocabulary's version, as renaming or
 * deleting a type takes them; the caller bumps the scopes last. Returns the
 * copies it made, for `dropUnusedAdoptionsInTx` once the share published
 * what it could.
 */
export async function adoptTypesForShareInTx(
    tx: Tx,
    {
        ownerUserId,
        orgUserId,
        entityIds,
        relationKeys,
    }: {
        ownerUserId: string;
        orgUserId: string;
        entityIds: readonly string[];
        relationKeys: readonly string[];
    },
): Promise<ShareAdoption[]> {
    const created: ShareAdoption[] = [];
    const needsAdoption = async (kind: TypeKind, adoptedAsKey: string | null) =>
        !adoptedAsKey || !(await sharedTypeKey(tx, kind, adoptedAsKey));

    // Which of the owner's relation types the facts need, and so which
    // entity types they relate, read first; locked in order below.
    const ownRelations =
        relationKeys.length > 0
            ? await tx
                  .select({
                      key: knowledgeRelationTypes.key,
                      adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                      subjectTypes: knowledgeRelationTypes.subjectTypes,
                      objectTypes: knowledgeRelationTypes.objectTypes,
                  })
                  .from(knowledgeRelationTypes)
                  .where(
                      and(
                          eq(knowledgeRelationTypes.userId, ownerUserId),
                          inArray(knowledgeRelationTypes.key, [
                              ...relationKeys,
                          ]),
                          eq(knowledgeRelationTypes.status, "active"),
                      ),
                  )
            : [];
    const entityTypeKeys = new Set<string>();
    for (const relation of ownRelations) {
        if (!(await needsAdoption("relation", relation.adoptedAsKey))) continue;
        for (const key of [...relation.subjectTypes, ...relation.objectTypes]) {
            entityTypeKeys.add(key);
        }
    }
    if (entityIds.length > 0) {
        const named = await tx
            .select({ typeKey: knowledgeEntities.typeKey })
            .from(knowledgeEntities)
            .where(
                and(
                    inArray(knowledgeEntities.id, [...entityIds]),
                    eq(knowledgeEntities.userId, ownerUserId),
                ),
            );
        for (const row of named) entityTypeKeys.add(row.typeKey);
    }
    if (entityTypeKeys.size === 0 && ownRelations.length === 0) return created;

    let changed = false;
    // The owner's entity types, then relation types, each in id order.
    const entityTypes =
        entityTypeKeys.size > 0
            ? await tx
                  .select()
                  .from(knowledgeEntityTypes)
                  .where(
                      and(
                          eq(knowledgeEntityTypes.userId, ownerUserId),
                          inArray(knowledgeEntityTypes.key, [
                              ...entityTypeKeys,
                          ]),
                          eq(knowledgeEntityTypes.status, "active"),
                      ),
                  )
                  .orderBy(asc(knowledgeEntityTypes.id))
                  .for("update")
            : [];
    const relationTypes =
        ownRelations.length > 0
            ? await tx
                  .select()
                  .from(knowledgeRelationTypes)
                  .where(
                      and(
                          eq(knowledgeRelationTypes.userId, ownerUserId),
                          inArray(
                              knowledgeRelationTypes.key,
                              ownRelations.map((relation) => relation.key),
                          ),
                          eq(knowledgeRelationTypes.status, "active"),
                      ),
                  )
                  .orderBy(asc(knowledgeRelationTypes.id))
                  .for("update")
            : [];

    // The owner's entity type keys as the Organization reads them.
    const asShared = new Map<string, string>();
    for (const type of entityTypes) {
        if (!(await needsAdoption("entity", type.adoptedAsKey))) {
            asShared.set(type.key, type.adoptedAsKey ?? type.key);
            continue;
        }
        const label = decryptText(type.label);
        let key = await sharedTypeNamed(tx, "entity", type.labelHmac);
        if (!key) {
            key = await insertAdoptedTypeInTx(tx, {
                kind: "entity",
                label,
                orgUserId,
                ownerUserId,
            });
            if (key)
                created.push({ kind: "entity", key, memberTypeId: type.id });
        }
        if (!key) continue;
        await tx
            .update(knowledgeEntityTypes)
            .set({ adoptedAsKey: key, updatedAt: new Date() })
            .where(eq(knowledgeEntityTypes.id, type.id));
        asShared.set(type.key, key);
        changed = true;
    }

    for (const type of relationTypes) {
        const shape = {
            subjectTypes: type.subjectTypes.map((k) => asShared.get(k) ?? k),
            objectTypes: type.objectTypes.map((k) => asShared.get(k) ?? k),
            objectKind: type.objectKind,
            cardinality: type.cardinality,
        };
        if (!(await needsAdoption("relation", type.adoptedAsKey))) continue;
        // Relating a type that stayed private, it stays private too.
        const related = [...shape.subjectTypes, ...shape.objectTypes];
        let unshared = false;
        for (const key of related) {
            if (!(await sharedTypeKey(tx, "entity", key))) unshared = true;
        }
        if (unshared) continue;
        const label = decryptText(type.label);
        let key = await sharedRelationOfShape(tx, label, shape);
        if (!key) {
            key = await insertAdoptedTypeInTx(tx, {
                kind: "relation",
                label,
                orgUserId,
                ownerUserId,
                shape,
            });
            if (key) {
                created.push({ kind: "relation", key, memberTypeId: type.id });
            }
        }
        if (!key) continue;
        await tx
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: key, updatedAt: new Date() })
            .where(eq(knowledgeRelationTypes.id, type.id));
        changed = true;
    }
    if (changed) await bumpVocabularyVersionInTx(tx);
    return created;
}

/** A copy a share made of a member's type (`adoptTypesForShareInTx`). */
export type ShareAdoption = {
    kind: TypeKind;
    /** The Organization's new type. */
    key: string;
    /** The member's type adopted as it. */
    memberTypeId: string;
};

/**
 * Take back the copies a share made that nothing it published uses: a
 * fact that stayed private must not tell the curator the name of a
 * private type either. The member's type is adopted no longer. Relations
 * first, so an entity type only a dropped relation related goes too.
 */
export async function dropUnusedAdoptionsInTx(
    tx: Tx,
    created: readonly ShareAdoption[],
): Promise<void> {
    const dropped = new Set<string>();
    const drop = async (adoption: ShareAdoption) => {
        const table = tableOf(adoption.kind);
        await tx.delete(table).where(eq(table.key, adoption.key));
        await tx
            .update(table)
            .set({ adoptedAsKey: null, updatedAt: new Date() })
            .where(eq(table.id, adoption.memberTypeId));
        dropped.add(adoption.key);
    };
    for (const adoption of created) {
        if (adoption.kind !== "relation") continue;
        const [used] = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.relationKey, adoption.key))
            .limit(1);
        if (!used) await drop(adoption);
    }
    for (const adoption of created) {
        if (adoption.kind !== "entity") continue;
        const [named] = await tx
            .select({ id: knowledgeEntities.id })
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.typeKey, adoption.key))
            .limit(1);
        const [related] = await tx
            .select({ id: knowledgeRelationTypes.id })
            .from(knowledgeRelationTypes)
            .where(
                sql`${knowledgeRelationTypes.subjectTypes} ? ${adoption.key} or ${knowledgeRelationTypes.objectTypes} ? ${adoption.key}`,
            )
            .limit(1);
        if (!named && !related) await drop(adoption);
    }
    if (dropped.size > 0) await bumpVocabularyVersionInTx(tx);
}

type RelationShape = {
    subjectTypes: string[];
    objectTypes: string[];
    objectKind: "entity" | "literal";
    cardinality: "one" | "many";
};

function sameShape(a: RelationShape, b: RelationShape): boolean {
    const sameSet = (x: readonly string[], y: readonly string[]) =>
        new Set(x).size === new Set(y).size && x.every((k) => y.includes(k));
    return (
        sameSet(a.subjectTypes, b.subjectTypes) &&
        sameSet(a.objectTypes, b.objectTypes) &&
        a.objectKind === b.objectKind &&
        a.cardinality === b.cardinality
    );
}

/**
 * "name", then "name (2)", "name (3)"…: the names a share gives a copy of a
 * member's type when the name is taken (`insertAdoptedTypeInTx`).
 */
function numberedLabel(base: string, n: number): string {
    const suffix = n === 1 ? "" : ` (${n})`;
    return `${base.slice(0, MAX_TYPE_LABEL_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/**
 * A core or Organization relation type of `shape` named `label` or a
 * numbered copy of it, active: what a share adopts a member's relation as
 * rather than making another copy. Looked for along the numbers while each
 * name is taken.
 */
async function sharedRelationOfShape(
    tx: Tx,
    label: string,
    shape: RelationShape,
): Promise<string | null> {
    const base = label.trim().replace(/\s+/g, " ");
    for (let n = 1; ; n++) {
        const rows = await tx
            .select()
            .from(knowledgeRelationTypes)
            .where(
                and(
                    eq(
                        knowledgeRelationTypes.labelHmac,
                        domainLookupHash(
                            LABEL_DOMAIN.relation,
                            numberedLabel(base, n),
                        ),
                    ),
                    or(
                        isNull(knowledgeRelationTypes.userId),
                        orgOwnedCondition(knowledgeRelationTypes.userId),
                    ),
                ),
            );
        if (rows.length === 0) return null;
        const same = rows.find(
            (row) => row.status === "active" && sameShape(row, shape),
        );
        if (same) return same.key;
    }
}

/** The key, when a core or Organization type of the kind exists under it. */
async function sharedTypeKey(
    tx: Tx,
    kind: TypeKind,
    key: string,
): Promise<string | null> {
    const table = tableOf(kind);
    const [row] = await tx
        .select({ key: table.key })
        .from(table)
        .where(
            and(
                eq(table.key, key),
                or(isNull(table.userId), orgOwnedCondition(table.userId)),
                eq(table.status, "active"),
            ),
        )
        .limit(1);
    return row?.key ?? null;
}

/** A core or Organization type of the kind with that name, active. */
async function sharedTypeNamed(
    tx: Tx,
    kind: TypeKind,
    labelHmac: string,
): Promise<string | null> {
    const table = tableOf(kind);
    const [row] = await tx
        .select({ key: table.key })
        .from(table)
        .where(
            and(
                eq(table.labelHmac, labelHmac),
                or(isNull(table.userId), orgOwnedCondition(table.userId)),
                eq(table.status, "active"),
            ),
        )
        .limit(1);
    return row?.key ?? null;
}

/**
 * An Organization type copied from a member's for a share, marked for the
 * curator, under the member's name or, where a core or Organization type
 * has it (another shape, or retired), the first "name (n)" free. Null for
 * a name the deny list refuses now.
 */
async function insertAdoptedTypeInTx(
    tx: Tx,
    {
        kind,
        label,
        orgUserId,
        ownerUserId,
        shape,
    }: {
        kind: TypeKind;
        label: string;
        orgUserId: string;
        ownerUserId: string;
        shape?: RelationShape;
    },
): Promise<string | null> {
    const table = tableOf(kind);
    const taken = async (candidate: string) => {
        const [row] = await tx
            .select({ id: table.id })
            .from(table)
            .where(
                and(
                    eq(
                        table.labelHmac,
                        domainLookupHash(LABEL_DOMAIN[kind], candidate),
                    ),
                    or(isNull(table.userId), eq(table.userId, orgUserId)),
                ),
            )
            .limit(1);
        return Boolean(row);
    };
    // Checked when the member named it, but the deny list may have grown
    // since: such a type stays private.
    const base = label.trim().replace(/\s+/g, " ");
    if (!base || deniedTopicOf(base)) return null;
    const numbered = (n: number) => numberedLabel(base, n);
    let n = 1;
    while (await taken(numbered(n))) n++;
    const name = numbered(n);
    const key = `o_${nanoid(12)}`;
    const common = {
        userId: orgUserId,
        key,
        label: encryptText(name),
        labelHmac: domainLookupHash(LABEL_DOMAIN[kind], name),
        adoptedFromShare: true,
        createdByUserId: ownerUserId,
    };
    if (kind === "entity") {
        await tx.insert(knowledgeEntityTypes).values(common);
    } else if (shape) {
        await tx.insert(knowledgeRelationTypes).values({ ...common, ...shape });
    }
    return key;
}
