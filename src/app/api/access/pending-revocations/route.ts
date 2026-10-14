import { NextResponse } from "next/server";
import { requireAccessAdministrator } from "@/lib/access/route-context";
import { pendingRevocations } from "@/lib/access/service";
import { apiHandler } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/access/pending-revocations` -- the people who lost access to
 * Chatterbox whose sessions at the identity provider are still open.
 * Administrators of access only.
 */
export const GET = apiHandler(async (request: Request) => {
    const context = await requireAccessAdministrator(request);
    return NextResponse.json(
        { people: await pendingRevocations(context) },
        { headers: { "Cache-Control": "no-store" } },
    );
});
