import { NextResponse } from "next/server";
import { requireAccessAdministrator } from "@/lib/access/route-context";
import {
    accessHistory,
    changeAccess,
    getAccessDetail,
    parseAccessChange,
} from "@/lib/access/service";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { assertSameOriginJson } from "@/lib/http/same-origin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ subject: string }> };

async function subjectOf(context: Context | undefined): Promise<string> {
    const subject = (await context?.params)?.subject ?? "";
    if (!/^[A-Za-z0-9._@-]{1,255}$/.test(subject)) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid person", 400);
    }
    return subject;
}

/** `GET /api/access/subjects/{subject}` -- one person's access and its history. */
export const GET = apiHandler<Context>(async (request, context) => {
    const admin = await requireAccessAdministrator(request);
    const subject = await subjectOf(context);
    const [access, history] = await Promise.all([
        getAccessDetail(admin, subject),
        accessHistory(admin, subject),
    ]);
    return NextResponse.json(
        { access, history },
        { headers: { "Cache-Control": "no-store" } },
    );
});

/**
 * `PATCH /api/access/subjects/{subject}` -- `{ add, remove, revision }`:
 * change which capabilities the person's managed groups grant. Same-origin
 * JSON only; the revision names the access the screen showed.
 */
export const PATCH = apiHandler<Context>(async (request, context) => {
    assertSameOriginJson(request);
    const admin = await requireAccessAdministrator(request);
    const subject = await subjectOf(context);
    const body = await request.json().catch(() => null);
    const outcome = await changeAccess(admin, subject, parseAccessChange(body));
    return NextResponse.json(outcome);
});
