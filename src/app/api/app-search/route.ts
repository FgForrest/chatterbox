import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
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
    if (!SCOPES.has(scope) || query.length > 200 || query.length === 1) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid search scope or query",
            400,
        );
    }
    request.signal.throwIfAborted();
    const bucket = await consumeRateLimitBucket(`app-search:${viewer.userId}`, {
        limit: 10,
        windowMs: 60_000,
    });
    if (!bucket.allowed) {
        return NextResponse.json(
            { error: "Rate limit exceeded", code: ErrorCode.RATE_LIMITED },
            {
                status: 429,
                headers: {
                    "Retry-After": String(
                        Math.max(
                            1,
                            Math.ceil(
                                (bucket.resetAt.getTime() - Date.now()) / 1000,
                            ),
                        ),
                    ),
                },
            },
        );
    }
    return NextResponse.json(
        await searchApp(viewer, scope as AppSearchScope, query, request.signal),
        {
            headers: { "Cache-Control": "private, no-store" },
        },
    );
});
