import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { searchApp } from "@/lib/search/app-search";
import type { AppSearchScope } from "@/lib/search/types";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";

const SCOPES = new Set<string>(["chatter", "almanac", "tasks", "all"]);

/** Signed-in palette search: `?scope=chatter|almanac|tasks|all&q=...`. */
export const GET = apiHandler(async (request) => {
    const viewer = await requireTaskViewer(request);
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope") ?? "chatter";
    const query = (params.get("q") ?? "").trim();
    if (!SCOPES.has(scope) || query.length > 200) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid search scope or query",
            400,
        );
    }
    return NextResponse.json(
        await searchApp(viewer, scope as AppSearchScope, query),
        {
            headers: { "Cache-Control": "private, no-store" },
        },
    );
});
