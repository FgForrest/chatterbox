import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    deleteEntity,
    getEntity,
    MAX_ENTITY_DESCRIPTION_LENGTH,
    MAX_ENTITY_NAME_LENGTH,
    mergeEntities,
    updateEntity,
} from "@/lib/knowledge/entities";
import {
    accountsNamingEntities,
    jsonBody,
    replanExports,
} from "@/lib/knowledge/route-helpers";
import { assertOwnScopeWritable } from "@/lib/org/config";

type IdContext = { params: Promise<{ id: string }> };

async function visible(userId: string, id: string) {
    const entity = await getEntity(userId, id);
    if (!entity) {
        throw new AppError(ErrorCode.NOT_FOUND, "Entity not found", 404);
    }
    return entity;
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    return NextResponse.json({ entity: await visible(session.user.id, id) });
});

/**
 * Rename a thing, describe it, or give it another type, all or nothing. An
 * Organization thing is the organization account's to change (403 for
 * others); a member's description of one becomes their private notes.
 */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;
    const body = await jsonBody(request);
    const changes: {
        name?: string;
        typeKey?: string;
        description?: string | null;
    } = {};
    if (body.name !== undefined) {
        if (
            typeof body.name !== "string" ||
            body.name.trim().length > MAX_ENTITY_NAME_LENGTH
        ) {
            throw invalid("Expected a name of reasonable length", "name");
        }
        changes.name = body.name;
    }
    if (body.typeKey !== undefined) {
        if (typeof body.typeKey !== "string" || !body.typeKey) {
            throw invalid("Expected a type", "typeKey");
        }
        changes.typeKey = body.typeKey;
    }
    if (body.description !== undefined) {
        if (
            body.description !== null &&
            (typeof body.description !== "string" ||
                body.description.length > MAX_ENTITY_DESCRIPTION_LENGTH)
        ) {
            throw invalid(
                "Expected a description of reasonable length, or null",
                "description",
            );
        }
        changes.description = body.description as string | null;
    }
    await assertOwnScopeWritable(userId);
    await updateEntity(userId, id, changes);
    if (changes.name !== undefined) {
        await replanExports(await accountsNamingEntities([id]));
    }
    return NextResponse.json({ entity: await visible(userId, id) });
});

/**
 * Fold this thing into another of its type (`{mergeIntoId}`): a private
 * one into the caller's own or the Organization's, an Organization one
 * (its account only) into another of the Organization's.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;
    const body = await jsonBody(request);
    const mergeIntoId = body.mergeIntoId;
    if (typeof mergeIntoId !== "string" || !mergeIntoId) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "mergeIntoId is required",
            400,
            { field: "mergeIntoId" },
        );
    }
    if (mergeIntoId === id) {
        throw invalid("A thing cannot be merged into itself", "mergeIntoId");
    }
    await assertOwnScopeWritable(userId);
    await visible(userId, id);
    const target = await visible(userId, mergeIntoId);
    const affected = await accountsNamingEntities([id]);
    await mergeEntities(userId, mergeIntoId, id);
    await replanExports(affected);
    // The target may have been merged away meanwhile: report where the
    // thing actually went.
    const winner = target.mergedIntoId
        ? await getEntity(userId, target.mergedIntoId)
        : target;
    return NextResponse.json({ entity: winner ?? target });
});

/**
 * Erase a thing, its nicknames, the facts about it and the corrections
 * linking to it. An Organization thing is its account's to erase.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;
    await assertOwnScopeWritable(userId);
    await visible(userId, id);
    const affected = await accountsNamingEntities([id]);
    await deleteEntity(userId, id);
    await replanExports(affected);
    return NextResponse.json({ deleted: true });
});

function invalid(message: string, field: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, { field });
}
