import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { folderRestrictionContacts } from "@/lib/folders/restriction-contacts";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as Context).params;
    return NextResponse.json(
        await folderRestrictionContacts(session.user.id, id),
    );
});
