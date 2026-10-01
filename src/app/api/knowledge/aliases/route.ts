import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { addAlias, MAX_ALIAS_LENGTH } from "@/lib/knowledge/aliases";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import { targetOf } from "@/lib/knowledge/route-targets";
import { assertOwnScopeWritable } from "@/lib/org/config";

/**
 * Give a person or a thing a nickname (`{target: {personId | entityId},
 * text}`), in
 * the caller's own scope: theirs alone, or the Organization's for its
 * account. 409 when the caller gave them that name already.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const body = await jsonBody(request);
    const target = targetOf(body.target, "target");
    if (
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > MAX_ALIAS_LENGTH
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Expected a nickname of reasonable length",
            400,
            { field: "text" },
        );
    }
    await assertOwnScopeWritable(session.user.id);
    const id = await addAlias(session.user.id, target, body.text);
    return NextResponse.json({ id }, { status: 201 });
});
