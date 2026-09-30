/**
 * Other names of a person or an entity.
 *
 * - `alias`: a name someone typed ("Honza" for Jan Novotný); it lasts.
 * - `heard_as`: how a transcription provider rendered the name in one
 *   language ("Novák" for Novotný), taught by the correction that put it
 *   right; it goes with that correction.
 *
 * An alias belongs to a scope, like everything else here: a user's
 * nickname for an Organization person is theirs alone, and the
 * Organization's aliases are everyone's.
 */

import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import {
    knowledgeAliases,
    knowledgeEntities,
    people,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { entitiesVisibleTo } from "@/lib/knowledge/entities";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    lockOrgPeopleShared,
    orgOwnedCondition,
} from "@/lib/knowledge/org-people";
import { peopleVisibleTo } from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

const TEXT_DOMAIN = "alias";
export const MAX_ALIAS_LENGTH = 200;

/** Who or what a name, a correction or a fact is about. */
export type KnowledgeTarget = { personId: string } | { entityId: string };

export interface Alias {
    id: string;
    kind: "alias" | "heard_as";
    text: string;
    language: string | null;
    provider: string | null;
    personId: string | null;
    entityId: string | null;
    scope: "personal" | "org";
}

/** SQL predicate: an alias `userId` may see -- their own, or the Organization's. */
export function aliasesVisibleTo(userId: string) {
    return or(
        eq(knowledgeAliases.userId, userId),
        orgOwnedCondition(knowledgeAliases.userId),
    );
}

function aliasNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Alias not found", 404);
}

function targetNotFound(target: KnowledgeTarget): AppError {
    return "personId" in target
        ? new AppError(ErrorCode.NOT_FOUND, "Person not found", 404)
        : new AppError(ErrorCode.NOT_FOUND, "Entity not found", 404);
}

function cleanText(text: string): string {
    const clean = text.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!clean) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "An alias needs text",
            400,
            {
                field: "text",
            },
        );
    }
    if (clean.length > MAX_ALIAS_LENGTH) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The alias is too long",
            400,
            { field: "text" },
        );
    }
    return clean;
}

/**
 * The person or entity `actorUserId` may see behind `target`: their own or
 * the Organization's. A merged-away id resolves to the one it was folded
 * into; anything else answers as missing.
 */
export async function resolveTargetInTx(
    executor: Executor,
    actorUserId: string,
    target: KnowledgeTarget,
): Promise<KnowledgeTarget> {
    let id = "personId" in target ? target.personId : target.entityId;
    for (let hops = 0; hops < 2; hops++) {
        const [row] =
            "personId" in target
                ? await executor
                      .select({
                          id: people.id,
                          mergedIntoId: people.mergedIntoId,
                      })
                      .from(people)
                      .where(
                          and(eq(people.id, id), peopleVisibleTo(actorUserId)),
                      )
                      .limit(1)
                : await executor
                      .select({
                          id: knowledgeEntities.id,
                          mergedIntoId: knowledgeEntities.mergedIntoId,
                      })
                      .from(knowledgeEntities)
                      .where(
                          and(
                              eq(knowledgeEntities.id, id),
                              entitiesVisibleTo(actorUserId),
                          ),
                      )
                      .limit(1);
        if (!row) break;
        if (!row.mergedIntoId) {
            return "personId" in target
                ? { personId: row.id }
                : { entityId: row.id };
        }
        id = row.mergedIntoId;
    }
    throw targetNotFound(target);
}

function targetColumns(target: KnowledgeTarget) {
    return "personId" in target
        ? { personId: target.personId, entityId: null }
        : { personId: null, entityId: target.entityId };
}

function targetCondition(target: KnowledgeTarget) {
    return "personId" in target
        ? eq(knowledgeAliases.personId, target.personId)
        : eq(knowledgeAliases.entityId, target.entityId);
}

/**
 * Give a person or an entity another name, in the actor's scope. 409 when
 * the actor already gave them that name.
 */
export async function addAlias(
    actorUserId: string,
    target: KnowledgeTarget,
    text: string,
): Promise<string> {
    const clean = cleanText(text);
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const resolved = await resolveTargetInTx(tx, actorUserId, target);
        const [row] = await tx
            .insert(knowledgeAliases)
            .values({
                userId: actorUserId,
                ...targetColumns(resolved),
                kind: "alias",
                text: encryptText(clean),
                textHmac: domainLookupHash(TEXT_DOMAIN, clean),
                createdByUserId: actorUserId,
            })
            .onConflictDoNothing()
            .returning({ id: knowledgeAliases.id });
        if (!row) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "They already have that name",
                409,
                { field: "text" },
            );
        }
        await bumpScopeInTx(tx, [actorUserId]);
        return row.id;
    });
}

/**
 * Take back a name the actor gave. A heard-as form goes with its
 * correction instead. 404 alike for a missing alias and another account's.
 */
export async function removeAlias(
    actorUserId: string,
    aliasId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        const deleted = await tx
            .delete(knowledgeAliases)
            .where(
                and(
                    eq(knowledgeAliases.id, aliasId),
                    eq(knowledgeAliases.userId, actorUserId),
                    eq(knowledgeAliases.kind, "alias"),
                ),
            )
            .returning({ id: knowledgeAliases.id });
        if (deleted.length === 0) throw aliasNotFound();
        await bumpScopeInTx(tx, [actorUserId]);
    });
}

/** The other names of a person or entity that `viewerUserId` may see. */
export async function listAliases(
    viewerUserId: string,
    target: KnowledgeTarget,
): Promise<Alias[]> {
    const rows = await db
        .select({
            id: knowledgeAliases.id,
            ownerRole: users.role,
            kind: knowledgeAliases.kind,
            text: knowledgeAliases.text,
            language: knowledgeAliases.language,
            provider: knowledgeAliases.provider,
            personId: knowledgeAliases.personId,
            entityId: knowledgeAliases.entityId,
        })
        .from(knowledgeAliases)
        .innerJoin(users, eq(users.id, knowledgeAliases.userId))
        .where(and(targetCondition(target), aliasesVisibleTo(viewerUserId)))
        .orderBy(knowledgeAliases.createdAt);
    return rows.map(({ ownerRole, ...row }) => ({
        ...row,
        text: decryptText(row.text),
        scope: ownerRole === "org" ? "org" : "personal",
    }));
}

/**
 * Remember how the transcription heard a name a person just corrected, in
 * the scope the correction was made in (`scopeUserId`: the owner on a
 * private recording, the organization account on a shared one). The next
 * run may then pre-tick the same correction. Only a person's confirmation
 * teaches: callers skip pre-ticked corrections, and bump `scopeUserId`.
 */
export async function teachHeardAsInTx(
    tx: Tx,
    {
        scopeUserId,
        target,
        heard,
        language,
        provider,
        correctionId,
    }: {
        scopeUserId: string;
        target: KnowledgeTarget;
        heard: string;
        language: string | null;
        provider: string | null;
        correctionId: string;
    },
): Promise<void> {
    await tx
        .insert(knowledgeAliases)
        .values({
            userId: scopeUserId,
            ...targetColumns(target),
            kind: "heard_as",
            text: encryptText(heard),
            textHmac: domainLookupHash(TEXT_DOMAIN, heard),
            language: language?.slice(0, 16) ?? null,
            provider: provider?.slice(0, 64) ?? null,
            correctionId,
            createdByUserId: scopeUserId,
        })
        .onConflictDoNothing();
}
