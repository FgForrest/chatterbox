/**
 * The organizations, teams, projects, products, terms, locations and
 * documents people talk about, beside the people in `people.ts`.
 *
 * Two layers, as for people: a user's own entities, and the Organization's,
 * owned by the organization account, which everyone sees and only it
 * changes. A member's description of an Organization entity is theirs
 * alone (`knowledge_entity_notes`), as a note on an Organization person is.
 *
 * Organization entities are serialized by the Organization-people lock
 * (`lockOrgPeople`): sharing promotes both in one transaction.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityNotes,
    knowledgeEntityTypes,
    knowledgeFacts,
    knowledgeRelationTypes,
    transcriptCorrections,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { deleteFactsNamingInTx } from "@/lib/knowledge/fact-chains";
import { moveFactsInTx } from "@/lib/knowledge/fact-merge";
import { relationFits } from "@/lib/knowledge/fact-rules";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    lockOrgPeople,
    lockRecordingsNaming,
    orgOwnedCondition,
    visibleOwnerCondition,
} from "@/lib/knowledge/org-people";
import {
    bumpScopeInTx,
    scopesNamingInTx,
} from "@/lib/knowledge/scope-generation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

const NAME_DOMAIN = "entity-name";
export const MAX_ENTITY_NAME_LENGTH = 200;
export const MAX_ENTITY_DESCRIPTION_LENGTH = 4000;

export type EntityScope = "personal" | "org";

/** An entity as feature code sees it: decrypted, never the stored row. */
export interface Entity {
    id: string;
    typeKey: string;
    name: string;
    /** The entity's own description: its owner's, or the Organization's. */
    description: string | null;
    /** The viewer's private notes on an Organization entity; else null. */
    notes: string | null;
    /** Set on a merge's tombstone, naming the entity it redirects to. */
    mergedIntoId: string | null;
    scope: EntityScope;
    createdAt: Date;
    updatedAt: Date;
}

interface EntityRow {
    id: string;
    userId: string;
    ownerRole: string;
    typeKey: string;
    name: string;
    nameHmac: string;
    description: string | null;
    mergedIntoId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const entityColumns = {
    id: knowledgeEntities.id,
    userId: knowledgeEntities.userId,
    ownerRole: users.role,
    typeKey: knowledgeEntities.typeKey,
    name: knowledgeEntities.name,
    nameHmac: knowledgeEntities.nameHmac,
    description: knowledgeEntities.description,
    mergedIntoId: knowledgeEntities.mergedIntoId,
    createdAt: knowledgeEntities.createdAt,
    updatedAt: knowledgeEntities.updatedAt,
};

/** SQL predicate: an entity `userId` may see -- their own, or the Organization's. */
export function entitiesVisibleTo(userId: string) {
    return visibleOwnerCondition(knowledgeEntities.userId, userId);
}

function entityNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Entity not found", 404);
}

function curatorOnly(): AppError {
    return new AppError(
        ErrorCode.FORBIDDEN,
        "Only the organization account can change an Organization entity",
        403,
    );
}

function invalid(message: string, field: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, { field });
}

function cleanName(name: string): string {
    const clean = name.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!clean) throw invalid("An entity needs a name", "name");
    if (clean.length > MAX_ENTITY_NAME_LENGTH) {
        throw invalid("The name is too long", "name");
    }
    return clean;
}

function cleanDescription(description: string | null): string | null {
    const clean = description?.normalize("NFC").trim() ?? "";
    if (clean.length > MAX_ENTITY_DESCRIPTION_LENGTH) {
        throw invalid("The description is too long", "description");
    }
    return clean || null;
}

function nameHmacOf(name: string): string {
    return domainLookupHash(NAME_DOMAIN, name);
}

function toEntity(row: EntityRow, viewerNotes?: string | null): Entity {
    const scope: EntityScope = row.ownerRole === "org" ? "org" : "personal";
    return {
        id: row.id,
        typeKey: row.typeKey,
        name: decryptText(row.name),
        description: row.description ? decryptText(row.description) : null,
        notes: scope === "org" && viewerNotes ? decryptText(viewerNotes) : null,
        mergedIntoId: row.mergedIntoId,
        scope,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

async function readEntityRow(
    executor: Executor,
    entityId: string,
): Promise<EntityRow | null> {
    const [row] = await executor
        .select(entityColumns)
        .from(knowledgeEntities)
        .innerJoin(users, eq(users.id, knowledgeEntities.userId))
        .where(eq(knowledgeEntities.id, entityId))
        .limit(1);
    return row ?? null;
}

async function viewerNotesFor(
    executor: Executor,
    userId: string,
    entityIds: string[],
): Promise<Map<string, string>> {
    if (entityIds.length === 0) return new Map();
    const rows = await executor
        .select({
            entityId: knowledgeEntityNotes.entityId,
            notes: knowledgeEntityNotes.notes,
        })
        .from(knowledgeEntityNotes)
        .where(
            and(
                eq(knowledgeEntityNotes.userId, userId),
                inArray(knowledgeEntityNotes.entityId, entityIds),
            ),
        );
    return new Map(rows.map((row) => [row.entityId, row.notes]));
}

/**
 * An entity `actorId` may change: their own, which for the organization
 * account are the Organization's. An Organization entity is seen by all
 * and changed by it alone (403); anyone else's answers as missing.
 */
async function requireManageable(
    executor: Executor,
    actorId: string,
    entityId: string,
): Promise<EntityRow> {
    const row = await readEntityRow(executor, entityId);
    if (!row) throw entityNotFound();
    if (row.userId === actorId) return row;
    if (row.ownerRole === "org") throw curatorOnly();
    throw entityNotFound();
}

/** The one live entity of that name and type in an owner's scope, if any. */
async function sameNamed(
    executor: Executor,
    ownerUserId: string,
    typeKey: string,
    nameHmac: string,
): Promise<string | null> {
    const [row] = await executor
        .select({ id: knowledgeEntities.id })
        .from(knowledgeEntities)
        .where(
            and(
                eq(knowledgeEntities.userId, ownerUserId),
                eq(knowledgeEntities.typeKey, typeKey),
                eq(knowledgeEntities.nameHmac, nameHmac),
                isNull(knowledgeEntities.mergedIntoId),
            ),
        )
        .limit(1);
    return row?.id ?? null;
}

function alreadyNamed(existingId: string): AppError {
    return new AppError(
        ErrorCode.CONFLICT,
        "An entity of that type already has that name",
        409,
        { field: "name", existingId },
    );
}

/**
 * Whether `ownerUserId` may give an entity this type: an active core type,
 * the Organization's, or their own. Never `person`: people live in
 * `people`, and an entity of type person would split one human in two.
 */
async function assertTypeUsable(
    executor: Executor,
    ownerUserId: string,
    typeKey: string,
): Promise<void> {
    if (typeKey === "person") {
        throw invalid("People are not entities", "typeKey");
    }
    const [row] = await executor
        .select({ key: knowledgeEntityTypes.key })
        .from(knowledgeEntityTypes)
        .where(
            and(
                eq(knowledgeEntityTypes.key, typeKey),
                eq(knowledgeEntityTypes.status, "active"),
                or(
                    isNull(knowledgeEntityTypes.userId),
                    visibleOwnerCondition(
                        knowledgeEntityTypes.userId,
                        ownerUserId,
                    ),
                ),
            ),
        )
        .limit(1);
    if (!row) throw invalid("Unknown entity type", "typeKey");
}

/**
 * Create an entity in the actor's own scope: the organization account
 * creates the Organization's. 409 with `details.existingId` when the scope
 * already has one of that name and type.
 */
export async function createEntity(
    actorUserId: string,
    {
        typeKey,
        name,
        description = null,
    }: { typeKey: string; name: string; description?: string | null },
): Promise<Entity> {
    const id = await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const created = await createEntityInTx(tx, actorUserId, {
            typeKey,
            name,
            description,
        });
        await bumpScopeInTx(tx, [actorUserId]);
        return created;
    });
    const entity = await getEntity(actorUserId, id);
    if (!entity) throw entityNotFound();
    return entity;
}

/**
 * `createEntity` inside a caller's transaction, which holds the
 * Organization-people lock and bumps the actor's scope. Returns the id.
 */
export async function createEntityInTx(
    tx: Tx,
    actorUserId: string,
    {
        typeKey,
        name,
        description = null,
    }: { typeKey: string; name: string; description?: string | null },
): Promise<string> {
    const clean = cleanName(name);
    const cleanText = cleanDescription(description);
    const nameHmac = nameHmacOf(clean);
    await assertTypeUsable(tx, actorUserId, typeKey);
    const existing = await sameNamed(tx, actorUserId, typeKey, nameHmac);
    if (existing) throw alreadyNamed(existing);
    const [created] = await tx
        .insert(knowledgeEntities)
        .values({
            userId: actorUserId,
            typeKey,
            name: encryptText(clean),
            nameHmac,
            description: cleanText ? encryptText(cleanText) : null,
            createdByUserId: actorUserId,
        })
        .returning({ id: knowledgeEntities.id });
    return (created as { id: string }).id;
}

/**
 * The live entity of that name and type in `ownerUserId`'s scope, if any:
 * how an import or a review finds a thing that exists already.
 */
export async function findEntityByNameInTx(
    tx: Tx,
    ownerUserId: string,
    typeKey: string,
    name: string,
): Promise<string | null> {
    return sameNamed(tx, ownerUserId, typeKey, nameHmacOf(cleanName(name)));
}

/** An entity by id, tombstones included, if `viewerUserId` may see it. */
export async function getEntity(
    viewerUserId: string,
    entityId: string,
): Promise<Entity | null> {
    const [row] = await db
        .select(entityColumns)
        .from(knowledgeEntities)
        .innerJoin(users, eq(users.id, knowledgeEntities.userId))
        .where(
            and(
                eq(knowledgeEntities.id, entityId),
                entitiesVisibleTo(viewerUserId),
            ),
        )
        .limit(1);
    if (!row) return null;
    const notes =
        row.ownerRole === "org"
            ? (await viewerNotesFor(db, viewerUserId, [row.id])).get(row.id)
            : undefined;
    return toEntity(row, notes);
}

/** The entities `viewerUserId` sees, most recently changed first. */
export async function listEntities(
    viewerUserId: string,
    { typeKey }: { typeKey?: string } = {},
): Promise<Entity[]> {
    const rows = await db
        .select(entityColumns)
        .from(knowledgeEntities)
        .innerJoin(users, eq(users.id, knowledgeEntities.userId))
        .where(
            and(
                entitiesVisibleTo(viewerUserId),
                isNull(knowledgeEntities.mergedIntoId),
                typeKey ? eq(knowledgeEntities.typeKey, typeKey) : undefined,
            ),
        )
        .orderBy(sql`${knowledgeEntities.updatedAt} desc`);
    const notes = await viewerNotesFor(
        db,
        viewerUserId,
        rows.filter((row) => row.ownerRole === "org").map((row) => row.id),
    );
    return rows.map((row) => toEntity(row, notes.get(row.id)));
}

/** Rename an entity the actor may change. */
export async function renameEntity(
    actorUserId: string,
    entityId: string,
    name: string,
): Promise<void> {
    await updateEntity(actorUserId, entityId, { name });
}

/**
 * Give an entity the actor may change another type: a product that is
 * really a project, say. 409 when that type already has one of its name,
 * or when a current fact of the actor's own about it would no longer fit
 * its relation (`details.factId`, `details.relationKey`): change or erase
 * that fact first. Facts others keep about it are theirs, and stay.
 */
export async function retypeEntity(
    actorUserId: string,
    entityId: string,
    typeKey: string,
): Promise<void> {
    await updateEntity(actorUserId, entityId, { typeKey });
}

/**
 * Change an entity's name, type and description at once, all or nothing:
 * `renameEntity`, `retypeEntity` and `describeEntity` in one transaction.
 * A member's description of an Organization entity is their private
 * notes; a name or type there is the organization account's (403).
 */
export async function updateEntity(
    actorUserId: string,
    entityId: string,
    changes: { name?: string; typeKey?: string; description?: string | null },
): Promise<void> {
    const clean = changes.name === undefined ? null : cleanName(changes.name);
    const cleanText =
        changes.description === undefined
            ? undefined
            : cleanDescription(changes.description);
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const scopes = new Set<string>();
        let row: EntityRow;
        if (clean !== null || changes.typeKey !== undefined) {
            row = await requireManageable(tx, actorUserId, entityId);
        } else {
            const read = await readEntityRow(tx, entityId);
            if (
                !read ||
                (read.userId !== actorUserId && read.ownerRole !== "org")
            ) {
                throw entityNotFound();
            }
            row = read;
        }
        if (row.mergedIntoId) throw entityNotFound();
        const typeKey = changes.typeKey ?? row.typeKey;
        const nameHmac = clean === null ? row.nameHmac : nameHmacOf(clean);
        if (typeKey !== row.typeKey) {
            await assertTypeUsable(tx, row.userId, typeKey);
            const misfit = await factNotFittingInTx(
                tx,
                entityId,
                typeKey,
                actorUserId,
            );
            if (misfit) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "A fact about it would no longer fit its relation",
                    409,
                    { field: "typeKey", ...misfit },
                );
            }
        }
        if (typeKey !== row.typeKey || nameHmac !== row.nameHmac) {
            const existing = await sameNamed(tx, row.userId, typeKey, nameHmac);
            if (existing && existing !== entityId) throw alreadyNamed(existing);
        }
        if (clean !== null || typeKey !== row.typeKey) {
            await tx
                .update(knowledgeEntities)
                .set({
                    ...(clean === null
                        ? {}
                        : { name: encryptText(clean), nameHmac }),
                    typeKey,
                    updatedAt: new Date(),
                })
                .where(eq(knowledgeEntities.id, entityId));
            // Its merged-away records follow, so a merge into a stale id
            // compares the type the entity has now.
            if (typeKey !== row.typeKey) {
                await tx
                    .update(knowledgeEntities)
                    .set({ typeKey, updatedAt: new Date() })
                    .where(eq(knowledgeEntities.mergedIntoId, entityId));
            }
            // A new name or type reads differently everywhere it is named.
            for (const scope of await scopesNamingInTx(tx, {
                entityIds: [entityId],
            })) {
                scopes.add(scope);
            }
        }
        if (cleanText !== undefined) {
            await describeEntityInTx(tx, actorUserId, row, cleanText);
            scopes.add(actorUserId);
        }
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * The first current fact of `scopeUserId`'s naming `entityId` that its
 * relation would refuse were the entity of type `typeKey`, or null when
 * all would still fit. Other scopes' facts are not the actor's to fix.
 */
async function factNotFittingInTx(
    tx: Tx,
    entityId: string,
    typeKey: string,
    scopeUserId: string,
): Promise<{ factId: string; relationKey: string } | null> {
    const facts = await tx
        .select({
            id: knowledgeFacts.id,
            userId: knowledgeFacts.userId,
            relationKey: knowledgeFacts.relationKey,
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
            objectLiteral: knowledgeFacts.objectLiteral,
        })
        .from(knowledgeFacts)
        .where(
            and(
                eq(knowledgeFacts.userId, scopeUserId),
                isNull(knowledgeFacts.replacedByFactId),
                or(
                    eq(knowledgeFacts.subjectEntityId, entityId),
                    eq(knowledgeFacts.objectEntityId, entityId),
                ),
            ),
        );
    const typeOf = async (
        personId: string | null,
        otherEntityId: string | null,
    ): Promise<string> => {
        if (personId) return "person";
        if (otherEntityId === entityId) return typeKey;
        const [other] = await tx
            .select({ typeKey: knowledgeEntities.typeKey })
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.id, otherEntityId ?? ""))
            .limit(1);
        return other?.typeKey ?? "";
    };
    for (const fact of facts) {
        // The relation as the fact's scope reads it: core, the
        // Organization's, or the scope's own.
        const [relation] = await tx
            .select({
                subjectTypes: knowledgeRelationTypes.subjectTypes,
                objectTypes: knowledgeRelationTypes.objectTypes,
                objectKind: knowledgeRelationTypes.objectKind,
            })
            .from(knowledgeRelationTypes)
            .where(
                and(
                    eq(knowledgeRelationTypes.key, fact.relationKey),
                    or(
                        isNull(knowledgeRelationTypes.userId),
                        visibleOwnerCondition(
                            knowledgeRelationTypes.userId,
                            fact.userId,
                        ),
                    ),
                ),
            )
            .limit(1);
        if (!relation) continue;
        const fits = relationFits(
            {
                subjectTypes: relation.subjectTypes,
                objectTypes: relation.objectTypes,
                objectKind: relation.objectKind as "entity" | "literal",
            },
            await typeOf(fact.subjectPersonId, fact.subjectEntityId),
            fact.objectLiteral
                ? { literal: true }
                : {
                      type: await typeOf(
                          fact.objectPersonId,
                          fact.objectEntityId,
                      ),
                  },
        );
        if (!fits) return { factId: fact.id, relationKey: fact.relationKey };
    }
    return null;
}

/**
 * Describe an entity. The actor's own entity (the organization account's
 * being the Organization's) gets its description; an Organization entity
 * described by a member gets that member's private notes instead. Null or
 * blank clears it.
 */
export async function describeEntity(
    actorUserId: string,
    entityId: string,
    description: string | null,
): Promise<void> {
    await updateEntity(actorUserId, entityId, { description });
}

/** `describeEntity` on a row the caller read under the lock. */
async function describeEntityInTx(
    tx: Tx,
    actorUserId: string,
    row: EntityRow,
    clean: string | null,
): Promise<void> {
    const entityId = row.id;
    if (row.userId === actorUserId) {
        await tx
            .update(knowledgeEntities)
            .set({
                description: clean ? encryptText(clean) : null,
                updatedAt: new Date(),
            })
            .where(eq(knowledgeEntities.id, entityId));
        return;
    }
    if (!clean) {
        await tx
            .delete(knowledgeEntityNotes)
            .where(
                and(
                    eq(knowledgeEntityNotes.entityId, entityId),
                    eq(knowledgeEntityNotes.userId, actorUserId),
                ),
            );
        return;
    }
    await tx
        .insert(knowledgeEntityNotes)
        .values({
            entityId,
            userId: actorUserId,
            notes: encryptText(clean),
        })
        .onConflictDoUpdate({
            target: [
                knowledgeEntityNotes.entityId,
                knowledgeEntityNotes.userId,
            ],
            set: { notes: encryptText(clean), updatedAt: new Date() },
        });
}

/** Add `notes` (ciphertext) after whatever `userId` already noted there. */
async function appendEntityNotes(
    tx: Tx,
    entityId: string,
    userId: string,
    notes: string,
): Promise<void> {
    const [current] = await tx
        .select({
            id: knowledgeEntityNotes.id,
            notes: knowledgeEntityNotes.notes,
        })
        .from(knowledgeEntityNotes)
        .where(
            and(
                eq(knowledgeEntityNotes.entityId, entityId),
                eq(knowledgeEntityNotes.userId, userId),
            ),
        )
        .limit(1);
    if (!current) {
        await tx
            .insert(knowledgeEntityNotes)
            .values({ entityId, userId, notes });
        return;
    }
    const combined = [decryptText(current.notes), decryptText(notes)]
        .filter((text) => text.trim())
        .join("\n\n");
    await tx
        .update(knowledgeEntityNotes)
        .set({ notes: encryptText(combined), updatedAt: new Date() })
        .where(eq(knowledgeEntityNotes.id, current.id));
}

/**
 * Move everything that names `loserId` onto `winnerId` and leave a
 * tombstone. Works on ids alone; callers authorize and take the
 * Organization-people lock first.
 */
async function mergeEntitiesInTx(
    tx: Tx,
    winnerId: string,
    loserId: string,
): Promise<void> {
    await lockRecordingsNaming(tx, { entityIds: [winnerId, loserId] });

    // Two corrections never cover the same words, so repointing collides
    // with nothing.
    await tx
        .update(transcriptCorrections)
        .set({ targetEntityId: winnerId, updatedAt: new Date() })
        .where(eq(transcriptCorrections.targetEntityId, loserId));

    // An alias the survivor already has, in the same scope, wins; the
    // loser's copy goes.
    const other = alias(knowledgeAliases, "other");
    await tx
        .update(knowledgeAliases)
        .set({ entityId: winnerId, updatedAt: new Date() })
        .where(
            and(
                eq(knowledgeAliases.entityId, loserId),
                sql`not exists (${tx
                    .select({ id: other.id })
                    .from(other)
                    .where(
                        and(
                            eq(other.entityId, winnerId),
                            eq(other.userId, knowledgeAliases.userId),
                            eq(other.kind, knowledgeAliases.kind),
                            eq(other.textHmac, knowledgeAliases.textHmac),
                            sql`${other.correctionId} is not distinct from ${knowledgeAliases.correctionId}`,
                        ),
                    )})`,
            ),
        );
    await tx
        .delete(knowledgeAliases)
        .where(eq(knowledgeAliases.entityId, loserId));
    // Facts naming the loser, combined where they then say the same.
    await moveFactsInTx(tx, { entityId: loserId }, { entityId: winnerId });

    // Everyone's private notes on the loser follow it.
    const loserNotes = await tx
        .select({
            userId: knowledgeEntityNotes.userId,
            notes: knowledgeEntityNotes.notes,
        })
        .from(knowledgeEntityNotes)
        .where(eq(knowledgeEntityNotes.entityId, loserId));
    for (const note of loserNotes) {
        await appendEntityNotes(tx, winnerId, note.userId, note.notes);
    }
    if (loserNotes.length > 0) {
        await tx
            .delete(knowledgeEntityNotes)
            .where(eq(knowledgeEntityNotes.entityId, loserId));
    }

    // Chains collapse to the final winner, so a redirect is one hop.
    await tx
        .update(knowledgeEntities)
        .set({ mergedIntoId: winnerId, updatedAt: new Date() })
        .where(eq(knowledgeEntities.id, loserId));
    await tx
        .update(knowledgeEntities)
        .set({ mergedIntoId: winnerId, updatedAt: new Date() })
        .where(eq(knowledgeEntities.mergedIntoId, loserId));
}

/**
 * Fold `loserId` into `keepId`: two records of one project, say. The loser
 * must be the actor's; the survivor theirs or the Organization's, so a
 * private duplicate can be folded into the shared record, never the
 * reverse. Both must be of one type. A private loser's description goes
 * with it into the survivor: as the description when both are the actor's,
 * as the actor's private notes on an Organization survivor.
 */
export async function mergeEntities(
    actorUserId: string,
    keepId: string,
    loserId: string,
): Promise<void> {
    if (keepId === loserId) return;
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const loser = await requireManageable(tx, actorUserId, loserId);
        const keep = await readEntityRow(tx, keepId);
        if (
            !keep ||
            (keep.userId !== actorUserId && keep.ownerRole !== "org")
        ) {
            throw entityNotFound();
        }
        if (loser.ownerRole === "org" && keep.ownerRole !== "org") {
            throw curatorOnly();
        }
        const winnerId = keep.mergedIntoId ?? keepId;
        if (winnerId === loserId || loser.mergedIntoId) return;
        if (keep.typeKey !== loser.typeKey) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "Only entities of one type can be merged",
                409,
                { field: "typeKey" },
            );
        }
        const scopes = await scopesNamingInTx(tx, {
            entityIds: [winnerId, loserId],
        });
        await mergeEntitiesInTx(tx, winnerId, loserId);
        await mergeDescriptionInTx(tx, keep, loser, winnerId);
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * Fold `loserId` into `winnerId`, two live entities of one owner, as
 * `mergeEntities` does: a type merged into another leaving an owner with
 * two of one name. Callers take the Organization-people lock first.
 */
export async function foldEntityInTx(
    tx: Tx,
    winnerId: string,
    loserId: string,
): Promise<void> {
    const keep = await readEntityRow(tx, winnerId);
    const loser = await readEntityRow(tx, loserId);
    if (!keep || !loser) return;
    await mergeEntitiesInTx(tx, winnerId, loserId);
    await mergeDescriptionInTx(tx, keep, loser, winnerId);
}

/** Where a merged-away entity's description goes; see `mergeEntities`. */
async function mergeDescriptionInTx(
    tx: Tx,
    keep: EntityRow,
    loser: EntityRow,
    winnerId: string,
): Promise<void> {
    if (!loser.description) return;
    if (keep.userId === loser.userId) {
        const [winner] = await tx
            .select({ description: knowledgeEntities.description })
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.id, winnerId));
        const combined = [winner?.description, loser.description]
            .flatMap((text) => (text ? [decryptText(text)] : []))
            .join("\n\n");
        await tx
            .update(knowledgeEntities)
            .set({
                description: encryptText(combined),
                updatedAt: new Date(),
            })
            .where(eq(knowledgeEntities.id, winnerId));
    } else {
        await appendEntityNotes(tx, winnerId, loser.userId, loser.description);
    }
}

/**
 * Erase an entity the actor may change, with the tombstones of anything
 * merged into it. Its aliases, the corrections targeting it and everyone's
 * notes on it go with it (cascades).
 */
export async function deleteEntity(
    actorUserId: string,
    entityId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        await requireManageable(tx, actorUserId, entityId);
        const doomed = await tx
            .select({ id: knowledgeEntities.id })
            .from(knowledgeEntities)
            .where(
                or(
                    eq(knowledgeEntities.id, entityId),
                    eq(knowledgeEntities.mergedIntoId, entityId),
                ),
            );
        await lockRecordingsNaming(tx, {
            entityIds: doomed.map((row) => row.id),
        });
        // Read before the delete: it takes everyone's aliases, notes, facts
        // and corrections naming these.
        const scopes = await scopesNamingInTx(tx, {
            entityIds: doomed.map((row) => row.id),
        });
        // Before the cascade would: facts naming them as the value of a
        // chain leave it whole.
        await deleteFactsNamingInTx(tx, {
            entityIds: doomed.map((row) => row.id),
        });
        await tx.delete(knowledgeEntities).where(
            inArray(
                knowledgeEntities.id,
                doomed.map((row) => row.id),
            ),
        );
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * What sharing would make of an entity, decided without writing anything
 * (`promoteEntityInTx` acts on it). Null when it is gone; a merged-away id
 * stands for the one it was folded into.
 *
 * - `org`: it is the Organization's already.
 * - `private`: its type is private and not adopted (or adopted as a type
 *   the Organization no longer has), so the Organization cannot see it.
 * - `promote`: the Organization entity it would be, with the type it would
 *   take, and the Organization entity of that name and type it would fold
 *   into, if any.
 */
export type EntityPromotion =
    | { kind: "org"; orgEntityId: string; typeKey: string }
    | { kind: "private"; entityId: string }
    | {
          kind: "promote";
          orgEntityId: string;
          typeKey: string;
          row: EntityRow;
          foldInto: string | null;
      };

export async function planEntityPromotionInTx(
    tx: Tx,
    entityId: string,
    orgUserId: string,
): Promise<EntityPromotion | null> {
    const row = await readEntityRow(tx, entityId);
    if (!row) return null;
    if (row.mergedIntoId) {
        return planEntityPromotionInTx(tx, row.mergedIntoId, orgUserId);
    }
    if (row.userId === orgUserId || row.ownerRole === "org") {
        return { kind: "org", orgEntityId: row.id, typeKey: row.typeKey };
    }

    let typeKey = row.typeKey;
    const [type] = await tx
        .select({
            userId: knowledgeEntityTypes.userId,
            adoptedAsKey: knowledgeEntityTypes.adoptedAsKey,
        })
        .from(knowledgeEntityTypes)
        .where(
            and(
                eq(knowledgeEntityTypes.key, row.typeKey),
                or(
                    isNull(knowledgeEntityTypes.userId),
                    visibleOwnerCondition(
                        knowledgeEntityTypes.userId,
                        row.userId,
                    ),
                ),
            ),
        )
        .limit(1);
    if (type?.userId === row.userId) {
        if (
            !type.adoptedAsKey ||
            !(await isSharedEntityType(tx, type.adoptedAsKey))
        ) {
            return { kind: "private", entityId: row.id };
        }
        typeKey = type.adoptedAsKey;
    }
    const known = await sameNamed(tx, orgUserId, typeKey, row.nameHmac);
    return {
        kind: "promote",
        orgEntityId: known ?? row.id,
        typeKey,
        row,
        foldInto: known,
    };
}

/** A core or Organization entity type exists under `key`. */
async function isSharedEntityType(tx: Tx, key: string): Promise<boolean> {
    const [type] = await tx
        .select({ id: knowledgeEntityTypes.id })
        .from(knowledgeEntityTypes)
        .where(
            and(
                eq(knowledgeEntityTypes.key, key),
                or(
                    isNull(knowledgeEntityTypes.userId),
                    orgOwnedCondition(knowledgeEntityTypes.userId),
                ),
            ),
        )
        .limit(1);
    return Boolean(type);
}

/**
 * Make a private entity the Organization's, as sharing a recording that
 * names it does (`promotePersonInTx` for people). The caller holds the
 * Organization-people lock, and bumps the scopes naming the entity
 * (`scopesNamingInTx`, read first) and the Organization's at its end.
 *
 * A private type goes to the Organization type it was adopted as; one not
 * adopted refuses (409, `details.reason: "entityTypePrivate"`), as the
 * Organization cannot see it. An Organization entity of the same name and
 * type takes it in; otherwise it is reassigned in place. Its description
 * becomes its former owner's private notes, as a person's notes do.
 *
 * Returns the Organization entity's id, or null when it is gone.
 * Permanent: withdrawing the recording does not demote it.
 */
export async function promoteEntityInTx(
    tx: Tx,
    entityId: string,
    orgUserId: string,
): Promise<string | null> {
    const plan = await planEntityPromotionInTx(tx, entityId, orgUserId);
    if (!plan) return null;
    if (plan.kind === "org") return plan.orgEntityId;
    if (plan.kind === "private") {
        throw new AppError(
            ErrorCode.CONFLICT,
            "The entity's type is private",
            409,
            { reason: "entityTypePrivate", entityId: plan.entityId },
        );
    }

    const { row, typeKey, foldInto } = plan;
    if (foldInto) {
        await mergeEntitiesInTx(tx, foldInto, row.id);
        if (row.description) {
            await appendEntityNotes(tx, foldInto, row.userId, row.description);
        }
        return foldInto;
    }

    if (row.description) {
        await appendEntityNotes(tx, row.id, row.userId, row.description);
    }
    const [promoted] = await tx
        .update(knowledgeEntities)
        .set({
            userId: orgUserId,
            typeKey,
            description: null,
            createdByUserId: row.userId,
            updatedAt: new Date(),
        })
        .where(eq(knowledgeEntities.id, row.id))
        .returning({ id: knowledgeEntities.id });
    return promoted?.id ?? null;
}
