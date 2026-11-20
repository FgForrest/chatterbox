import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler, ErrorCode } from "@/lib/errors";
import { enforcePlaudSyncRateLimit } from "@/lib/plaud/sync-rate-limit";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";

export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const limited = await enforcePlaudSyncRateLimit(session.user.id);
    if (limited) return limited;

    const result = await syncRecordingsForUser(session.user.id, "manual");
    const counts = {
        newRecordings: result.newRecordings,
        updatedRecordings: result.updatedRecordings,
        inProgress: result.inProgress,
        needsReconnect: result.needsReconnect ?? false,
    };
    if (result.errorCode && !result.skipped) {
        const error = counts.needsReconnect
            ? "Plaud rejected the stored token. Reconnect your Plaud account."
            : "Failed to sync with Plaud device";
        const status = counts.needsReconnect
            ? 401
            : result.errorCode === ErrorCode.INTERNAL_ERROR
              ? 500
              : 502;
        return NextResponse.json(
            {
                ...counts,
                success: false,
                error,
                code: result.errorCode,
                errors: [error],
            },
            { status },
        );
    }

    return NextResponse.json({
        ...counts,
        success: true,
        errors: result.errors,
    });
});
