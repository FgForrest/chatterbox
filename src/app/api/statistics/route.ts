import { NextResponse } from "next/server";
import { loadStatistics } from "@/db/queries/statistics";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { requestTimeZone } from "@/lib/i18n/user-time-zone";
import { isStatisticsScope } from "@/lib/statistics/data";

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope") ?? "mine";
    if (!isStatisticsScope(scope)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Unknown statistics scope",
            400,
        );
    }
    const result = await loadStatistics(
        session.user.id,
        scope,
        params.get("tz") ?? (await requestTimeZone(session.user.id, request)),
    );
    return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
    });
});
