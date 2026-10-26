import { NextResponse } from "next/server";
import { loadStatistics } from "@/db/queries/statistics";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import type { StatisticsScope } from "@/lib/statistics/data";

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const params = new URL(request.url).searchParams;
    const result = await loadStatistics(
        session.user.id,
        (params.get("scope") ?? "mine") as StatisticsScope,
        params.get("tz") ?? "UTC",
    );
    return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
    });
});
