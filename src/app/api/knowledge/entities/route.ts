import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { MAX_ALIAS_LENGTH } from "@/lib/knowledge/aliases";
import {
    listEntities,
    MAX_ENTITY_DESCRIPTION_LENGTH,
    MAX_ENTITY_NAME_LENGTH,
} from "@/lib/knowledge/entities";
import { createEntityWithNicknames } from "@/lib/knowledge/entity-create";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import { assertOwnScopeWritable } from "@/lib/org/config";

const MAX_NICKNAMES = 20;

/** The things the caller sees, their own and the Organization's (`?typeKey=`). */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const typeKey = new URL(request.url).searchParams.get("typeKey");
    return NextResponse.json({
        entities: await listEntities(session.user.id, {
            typeKey: typeKey || undefined,
        }),
    });
});

/**
 * Add a thing to the caller's own scope (the organization account's is the
 * Organization's), with its nicknames. 409 with `details.existingId` when
 * one of that name and type exists.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const body = await jsonBody(request);
    const typeKey = text(body.typeKey, 64, "typeKey");
    const name = text(body.name, MAX_ENTITY_NAME_LENGTH, "name");
    if (!typeKey || !name) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A thing needs a type and a name",
            400,
            { field: typeKey ? "name" : "typeKey" },
        );
    }
    const description = text(
        body.description,
        MAX_ENTITY_DESCRIPTION_LENGTH,
        "description",
    );
    const nicknames = nicknamesOf(body.nicknames);
    await assertOwnScopeWritable(session.user.id);
    const entity = await createEntityWithNicknames(
        session.user.id,
        { typeKey, name, description },
        nicknames,
    );
    return NextResponse.json({ entity }, { status: 201 });
});

function text(value: unknown, max: number, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim().length > max) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Expected ${field} to be text of reasonable length`,
            400,
            { field },
        );
    }
    return value.trim() || null;
}

function nicknamesOf(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (
        !Array.isArray(value) ||
        value.length > MAX_NICKNAMES ||
        !value.every(
            (item) =>
                typeof item === "string" && item.length <= MAX_ALIAS_LENGTH,
        )
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Expected a short list of nicknames",
            400,
            { field: "nicknames" },
        );
    }
    return (value as string[]).map((item) => item.trim()).filter(Boolean);
}
