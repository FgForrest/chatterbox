import { NextResponse } from "next/server";
import { requireAccessAdministrator } from "@/lib/access/route-context";
import { revokeSessions } from "@/lib/access/service";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { assertSameOriginJson } from "@/lib/http/same-origin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ subject: string }> };

/**
 * `POST /api/access/subjects/{subject}/revoke-sessions` -- end the
 * person's sessions here and at the identity provider (also the retry of
 * a revocation that is still pending).
 */
export const POST = apiHandler<Context>(async (request, context) => {
    assertSameOriginJson(request);
    const admin = await requireAccessAdministrator(request);
    const subject = (await context?.params)?.subject ?? "";
    if (!/^[A-Za-z0-9._@-]{1,255}$/.test(subject)) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid person", 400);
    }
    return NextResponse.json(await revokeSessions(admin, subject));
});
