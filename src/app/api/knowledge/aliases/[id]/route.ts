import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { removeAlias } from "@/lib/knowledge/aliases";
import { assertOwnScopeWritable } from "@/lib/org/config";

type IdContext = { params: Promise<{ id: string }> };

/** Take back a nickname the caller gave; how transcription heard a name stays. */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await assertOwnScopeWritable(session.user.id);
    await removeAlias(session.user.id, id);
    return NextResponse.json({ deleted: true });
});
