import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import { objectOf, targetOf } from "@/lib/knowledge/route-targets";
import { assertOwnScopeWritable } from "@/lib/org/config";

/**
 * State a fact by hand (`{subject, relationKey, object}`), in the caller's
 * own scope. On a single-valued relation that holds a value already, 409
 * with `details.currentFactId`; send it back as `expectedCurrentFactId` to
 * replace that value. Text naming a denied topic is refused (400).
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const body = await jsonBody(request);
    const subject = targetOf(body.subject, "subject");
    const object = objectOf(body.object);
    if (typeof body.relationKey !== "string" || !body.relationKey) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A fact needs a relation",
            400,
            { field: "relationKey" },
        );
    }
    const expected = body.expectedCurrentFactId;
    if (
        expected !== undefined &&
        expected !== null &&
        typeof expected !== "string"
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Expected the current fact's id",
            400,
            { field: "expectedCurrentFactId" },
        );
    }
    await assertOwnScopeWritable(session.user.id);
    const id = await confirmManualFact(session.user.id, {
        subject,
        relationKey: body.relationKey,
        object,
        expectedCurrentFactId: (expected as string | null | undefined) ?? null,
    });
    return NextResponse.json({ id }, { status: 201 });
});
