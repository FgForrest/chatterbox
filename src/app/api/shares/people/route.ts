import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import { findShareRecipients } from "@/lib/sharing/person-shares";

export const GET = apiHandler(async (request) => {
    const session = await requirePersonShareSession(request);
    return NextResponse.json({
        people: await findShareRecipients(
            session.user.id,
            new URL(request.url).searchParams.get("q") ?? "",
        ),
    });
});
