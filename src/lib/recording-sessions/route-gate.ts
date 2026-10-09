import type { NextResponse } from "next/server";
import {
    type AuthenticatedRequest,
    authenticateRequest,
    requireApiScope,
} from "@/lib/auth-request";
import { isHostedLockedOut } from "@/lib/entitlements";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    enforceV1AuthenticatedRateLimit,
    enforceV1IpRateLimit,
} from "@/lib/v1/rate-limit";

export type RecordingSessionGate =
    | { response: NextResponse; authn?: undefined }
    | { response?: undefined; authn: AuthenticatedRequest };

/**
 * The checks every recording-session route runs before touching data:
 * rate limits, authentication, the write scope, and the hosted lockout.
 *
 * Rate-limit helpers hand back a ready response rather than throwing, so
 * this returns either a response to send or the authenticated principal.
 */
export async function gateRecordingSessionRequest(
    request: Request,
): Promise<RecordingSessionGate> {
    const ipLimitResponse = await enforceV1IpRateLimit(request);
    if (ipLimitResponse) return { response: ipLimitResponse };

    const authn = await authenticateRequest(request);
    if (!authn) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401);
    }

    const authLimitResponse = await enforceV1AuthenticatedRateLimit(authn);
    if (authLimitResponse) return { response: authLimitResponse };

    requireApiScope(authn, "recordings:write");

    if (await isHostedLockedOut(authn.user.id)) {
        throw new AppError(
            ErrorCode.ACCOUNT_LOCKED,
            "Your hosted plan has lapsed. Subscribe to resume uploads, or export your data.",
            403,
        );
    }

    return { authn };
}
