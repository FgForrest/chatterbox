import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { importList, MAX_IMPORT_BYTES } from "@/lib/knowledge/import-list";
import { jsonBody } from "@/lib/knowledge/route-helpers";
import { assertOwnScopeWritable } from "@/lib/org/config";

/**
 * Import a pasted list of people and things (`{text, dryRun}`) into the
 * caller's own scope. `dryRun` (the default) only says what each name
 * would do; `dryRun: false` does it, in one transaction.
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const body = await jsonBody(request, MAX_IMPORT_BYTES + 1024);
    if (typeof body.text !== "string" || !body.text.trim()) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "Paste a list to import",
            400,
            { field: "text" },
        );
    }
    const dryRun = body.dryRun !== false;
    if (!dryRun) await assertOwnScopeWritable(session.user.id);
    return NextResponse.json(
        await importList(session.user.id, body.text, { dryRun }),
    );
});
