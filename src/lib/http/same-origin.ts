import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";

/**
 * Refuse a state-changing request that did not come from this
 * application's own pages: it must carry an `Origin` equal to APP_URL's
 * (or, without one, `Sec-Fetch-Site: same-origin`) and a JSON body type.
 */
export function assertSameOriginJson(request: Request): void {
    const expected = env.APP_URL ? new URL(env.APP_URL).origin : null;
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    const sameOrigin =
        origin !== null
            ? expected !== null && origin === expected
            : fetchSite === "same-origin";
    const contentType = request.headers.get("content-type") ?? "";
    if (
        !sameOrigin ||
        !contentType.toLowerCase().startsWith("application/json")
    ) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Cross-site request refused",
            403,
        );
    }
}
