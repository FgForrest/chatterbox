import { requireApiSession } from "@/lib/auth-server";
import { AppError, ErrorCode } from "@/lib/errors";
import { isOrgScopeVisible } from "@/lib/org/config";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { requirePersonSharing } from "@/lib/sharing/person-shares";

/** Session and deployment gate shared by person-sharing routes. */
export async function requirePersonShareSession(request: Request) {
    if (!isOrgScopeVisible())
        throw new AppError(ErrorCode.NOT_FOUND, "Not found", 404);
    const session = await requireApiSession(request);
    await requirePersonSharing(session.user.id);
    const bucket = await consumeRateLimitBucket(
        `person-shares:${request.method}:${session.user.id}`,
        { limit: 60, windowMs: 60_000 },
    );
    if (!bucket.allowed)
        throw new AppError(
            ErrorCode.RATE_LIMITED,
            "Too many sharing requests",
            429,
        );
    return session;
}
