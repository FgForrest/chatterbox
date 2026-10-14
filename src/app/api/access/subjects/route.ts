import { NextResponse } from "next/server";
import { requireAccessAdministrator } from "@/lib/access/route-context";
import { listAccess } from "@/lib/access/service";
import { apiHandler } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/access/subjects?search=&page=` -- the people the identity
 * provider knows and their access. Administrators of access only.
 */
export const GET = apiHandler(async (request: Request) => {
    const context = await requireAccessAdministrator(request);
    const url = new URL(request.url);
    const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
    const result = await listAccess(context, {
        search: url.searchParams.get("search")?.slice(0, 100) ?? undefined,
        page: Number.isFinite(page) && page >= 0 ? page : 0,
        pageSize: 20,
    });
    return NextResponse.json(result, {
        headers: { "Cache-Control": "no-store" },
    });
});
