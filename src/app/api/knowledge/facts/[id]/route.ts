import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { deleteFact, replaceFact } from "@/lib/knowledge/facts";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import { objectOf } from "@/lib/knowledge/route-targets";
import { assertOwnScopeWritable } from "@/lib/org/config";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Change what a fact of the caller's own scope says (`{object}`): a fact
 * typed by hand takes its place. Answers the id of the fact now stating it.
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = await jsonBody(request);
    const object = objectOf(body.object);
    await assertOwnScopeWritable(session.user.id);
    return NextResponse.json({
        id: await replaceFact(session.user.id, id, object),
    });
});

/** Erase a fact of the caller's own scope, with its evidence. */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await assertOwnScopeWritable(session.user.id);
    await deleteFact(session.user.id, id);
    return NextResponse.json({ deleted: true });
});
