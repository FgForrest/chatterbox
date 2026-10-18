import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { requireMailEnabled } from "@/lib/mail/require-mail";
import { latestMailDeliveryVersion } from "@/lib/mail/status";

/** Return the newest accepted-mail token for the signed-in user. */
export const GET = apiHandler(async (request: Request) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    return NextResponse.json(
        { version: await latestMailDeliveryVersion(session.user.id) },
        { headers: { "Cache-Control": "private, no-store" } },
    );
});
