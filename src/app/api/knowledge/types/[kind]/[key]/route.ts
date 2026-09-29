import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    deleteOwnType,
    keepAdoptedType,
    MAX_TYPE_LABEL_LENGTH,
    mergeOwnTypes,
    renameOwnType,
    type TypeKind,
    typeMergeCount,
} from "@/lib/knowledge/vocabulary";

type TypeContext = { params: Promise<{ kind: string; key: string }> };

/**
 * One of the caller's own knowledge types (a member's private ones, the
 * Organization's for its account): `kind` is `entity` or `relation`.
 * Another account's type and a core type answer 404 alike.
 */
async function typeOf(context: TypeContext): Promise<{
    kind: TypeKind;
    key: string;
}> {
    const { kind, key } = await context.params;
    if (kind !== "entity" && kind !== "relation") {
        throw new AppError(ErrorCode.NOT_FOUND, "Type not found", 404);
    }
    return { kind, key };
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
    const body = (await request.json().catch(() => null)) as unknown;
    return body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
}

function countOf(body: Record<string, unknown>): number {
    const count = body.confirmCount;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "confirmCount is required: the number the person was shown",
            400,
            { field: "confirmCount" },
        );
    }
    return count;
}

function mergeTargetOf(value: unknown): string {
    if (typeof value !== "string" || !value) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "mergeInto is required",
            400,
            { field: "mergeInto" },
        );
    }
    return value;
}

/**
 * `?mergeInto=<key>`: how many of the caller's own things merging this
 * type into that one changes, the `confirmCount` a merge then sends.
 */
export const GET = apiHandler<TypeContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { kind, key } = await typeOf(context as TypeContext);
    const into = mergeTargetOf(
        new URL(request.url).searchParams.get("mergeInto"),
    );
    const count = await typeMergeCount(session.user.id, kind, key, into);
    return NextResponse.json({ count });
});

/**
 * `{ "label": "…" }` renames the type; `{ "keep": true }` keeps a type a
 * share adopted as it is, so it is no longer marked for review.
 */
export const PATCH = apiHandler<TypeContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { kind, key } = await typeOf(context as TypeContext);
    const body = await bodyOf(request);
    if (body.keep === true) {
        await keepAdoptedType(session.user.id, kind, key);
        return NextResponse.json({ success: true });
    }
    if (
        typeof body.label !== "string" ||
        !body.label.trim() ||
        body.label.trim().length > MAX_TYPE_LABEL_LENGTH
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Expected a name of reasonable length, or keep: true",
            400,
            { field: "label" },
        );
    }
    await renameOwnType(session.user.id, kind, key, body.label);
    return NextResponse.json({ success: true });
});

/**
 * Delete the type with what uses it. `{ "confirmCount": n }` must be the
 * number of uses the person was shown (409 with `details.count` when it
 * changed meanwhile).
 */
export const DELETE = apiHandler<TypeContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { kind, key } = await typeOf(context as TypeContext);
    const confirmCount = countOf(await bodyOf(request));
    await deleteOwnType(session.user.id, kind, key, confirmCount);
    return NextResponse.json({ success: true });
});

/**
 * Merge the type into another of the kind, the caller's own or a core one:
 * `{ "mergeInto": "<key>", "confirmCount": n }`, `n` as `GET` counted it.
 */
export const POST = apiHandler<TypeContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { kind, key } = await typeOf(context as TypeContext);
    const body = await bodyOf(request);
    const into = mergeTargetOf(body.mergeInto);
    const confirmCount = countOf(body);
    await mergeOwnTypes(session.user.id, kind, key, into, confirmCount);
    return NextResponse.json({ success: true });
});
