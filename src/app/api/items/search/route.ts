import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { type ItemSearchScope, searchItems } from "@/lib/search/item-search";

const MAX_QUERY = 200;
const ITEM_SEARCH_SCOPES = new Set<ItemSearchScope>([
    "title",
    "content",
    "summary",
]);

function parseScopes(value: string | null): ItemSearchScope[] | undefined {
    if (value === null) return undefined;
    const scopes = value.split(",").filter(Boolean);
    if (
        scopes.length === 0 ||
        scopes.some(
            (scope) => !ITEM_SEARCH_SCOPES.has(scope as ItemSearchScope),
        )
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid search scope",
            400,
        );
    }
    return scopes as ItemSearchScope[];
}

/**
 * Search the viewer's pile (`view=org`: the Organization's) for every word
 * of `q`, newest first, in what the browser does not hold: a mail's own
 * text, a recording's transcripts, and summaries as stored. `scope` is a
 * comma-separated subset of title, content and summary. Bounded: when
 * `complete` is false, pass `continueBefore` back as `before`.
 */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get("q") ?? "").trim();
    if (!query || query.length > MAX_QUERY) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `q must be 1 to ${MAX_QUERY} characters`,
            400,
        );
    }
    const before = searchParams.get("before");
    const result = await searchItems({
        viewerUserId: session.user.id,
        view: searchParams.get("view") === "org" ? "org" : "private",
        query,
        before: before && before.length <= 512 ? before : null,
        scopes: parseScopes(searchParams.get("scope")),
    });
    return NextResponse.json(result);
});
