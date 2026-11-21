import { NextResponse } from "next/server";
import { getExtracted } from "next-intl/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { assertNotOrgAccount } from "@/lib/org/config";
import {
    buildPlaudTokenSet,
    decodeAccessTokenExpiry,
    decodeJwtClaims,
    fetchPlaudUserMeEmail,
    isPlaudWorkspaceToken,
} from "@/lib/plaud/auth";
import { DEFAULT_PLAUD_API_BASE } from "@/lib/plaud/client";
import { persistPlaudConnection } from "@/lib/plaud/persist-connection";
import { isValidPlaudApiUrl } from "@/lib/plaud/servers";

const MAX_REFRESH_TOKEN_LENGTH = 8192;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const SHORT_LIVED_TOKEN_MS = 2 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function parseRefreshToken(raw: unknown, accessToken: string): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return null;
    const token = raw.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const claims =
        token.length <= MAX_REFRESH_TOKEN_LENGTH && JWT_SHAPE.test(token)
            ? decodeJwtClaims(token)
            : null;
    if (!claims || isPlaudWorkspaceToken(token)) return null;

    const refreshSub = typeof claims.sub === "string" ? claims.sub : "";
    const accessSub = decodeJwtClaims(accessToken)?.sub;
    if (
        !refreshSub ||
        typeof accessSub !== "string" ||
        !accessSub ||
        refreshSub !== accessSub
    ) {
        return null;
    }

    const exp = decodeAccessTokenExpiry(token);
    if (exp && exp.getTime() <= Date.now()) return null;
    return token;
}

/**
 * POST /api/plaud/auth/connect-token
 *
 * Connect a Plaud account by submitting an existing access token, bypassing
 * the OTP flow. This exists because Plaud's OTP login signs you into an
 * email-only account that is *separate* from any Google/Apple-linked account
 * sharing the same email address (issue #65) -- if you originally signed up
 * for Plaud via Google or Apple, the OTP flow returns a token for an empty
 * shadow account and your real recordings never appear.
 *
 * Accepts the Plaud web session cookie `pld_ut` and an optional refresh token
 * from connector 0.2.4+. An invalid refresh token is dropped with a warning.
 * The access token is still validated against Plaud before storing the connection.
 *
 * Source: https://github.com/riffado/riffado/blob/main/src/app/api/plaud/auth/connect-token/route.ts
 */
export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    await assertNotOrgAccount(session.user.id);

    const body = (await request.json().catch(() => null)) as {
        accessToken?: unknown;
        refreshToken?: unknown;
        apiBase?: unknown;
        source?: unknown;
    } | null;

    if (!body || typeof body.accessToken !== "string") {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "accessToken is required",
            400,
            { field: "accessToken" },
        );
    }

    const accessToken = body.accessToken.trim().replace(/^Bearer\s+/i, "");
    if (!accessToken) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "accessToken is required",
            400,
            { field: "accessToken" },
        );
    }

    // Cheap shape check: Plaud user tokens are JWTs (3 base64url segments).
    // Catches accidentally-pasted nonsense before we round-trip Plaud.
    if (accessToken.split(".").length !== 3) {
        const i18n = await getExtracted();
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            i18n(
                "That doesn't look like a Plaud access token. Copy the pld_ut cookie from web.plaud.ai (DevTools → Application → Cookies).",
            ),
            400,
            { field: "accessToken" },
        );
    }

    if (isPlaudWorkspaceToken(accessToken)) {
        const i18n = await getExtracted();
        throw new AppError(
            ErrorCode.PLAUD_WORKSPACE_TOKEN_PASTED,
            i18n(
                "That's a workspace token. Use Sign in with Plaud or copy the pld_ut cookie from web.plaud.ai (DevTools → Application → Cookies).",
            ),
            400,
            { field: "accessToken" },
        );
    }

    // UX-only `exp` check. We don't trust the decoded payload for any
    // security decision — Plaud is the verifier on /device/list below.
    // If `exp` is in the past we still bail, since /device/list will
    // 401 and the resulting message is less useful than this one.
    const exp = decodeAccessTokenExpiry(accessToken);
    if (exp && exp.getTime() <= Date.now()) {
        throw new AppError(
            ErrorCode.PLAUD_INVALID_TOKEN,
            "This Plaud access token has already expired. Sign in to web.plaud.ai again and copy a fresh one.",
            400,
        );
    }

    // SSRF guard: apiBase is user-supplied. Restrict to plaud.ai hosts.
    // Default to global if the client didn't pick a region; the paste
    // flow has no -302 redirect path so the user picks via a region
    // selector in the UI.
    const apiBaseRaw =
        typeof body.apiBase === "string" && body.apiBase.trim().length > 0
            ? body.apiBase.trim().replace(/\/+$/, "")
            : DEFAULT_PLAUD_API_BASE;

    if (!isValidPlaudApiUrl(apiBaseRaw)) {
        throw new AppError(
            ErrorCode.PLAUD_INVALID_API_BASE,
            "Invalid API base",
            400,
        );
    }

    // Best-effort email enrichment. Failure is non-fatal —
    // plaud_connections.plaud_email is nullable.
    const plaudEmail = await fetchPlaudUserMeEmail(accessToken, apiBaseRaw);

    const method =
        body.source === "connector" || body.source === "paste"
            ? body.source
            : "unknown";
    const suppliedRefreshToken =
        typeof body.refreshToken === "string"
            ? body.refreshToken.trim() || null
            : body.refreshToken;
    const refreshToken = parseRefreshToken(suppliedRefreshToken, accessToken);
    const tokens = buildPlaudTokenSet({ accessToken, refreshToken });

    const refreshTokenDropped = suppliedRefreshToken != null && !refreshToken;
    const remaining = tokens.accessExpiresAt
        ? tokens.accessExpiresAt.getTime() - Date.now()
        : Infinity;
    const shortLived = !refreshToken && remaining < SHORT_LIVED_TOKEN_MS;
    let warning: string | undefined;
    if (refreshTokenDropped || shortLived) {
        const i18n = await getExtracted();
        const warnings: string[] = [];
        if (refreshTokenDropped) {
            warnings.push(
                i18n(
                    "The refresh token could not be used. This connection will end when the access token expires.",
                ),
            );
        }
        if (shortLived) {
            const hours = Math.max(1, Math.ceil(remaining / HOUR_MS));
            warnings.push(
                i18n(
                    "This Plaud sign-in expires in {hours, plural, one {# hour} other {# hours}}.",
                    { hours },
                ),
                i18n(
                    "Connector 0.2.4 or newer keeps you connected for up to 30 days. You can also use an email code if you sign into Plaud with email and password.",
                ),
            );
        }
        warning = warnings.join(" ");
    }

    const { devices } = await persistPlaudConnection({
        userId: session.user.id,
        tokens,
        apiBase: apiBaseRaw,
        plaudEmail,
        method,
    });

    return NextResponse.json({
        success: true,
        devices,
        ...(warning ? { warning } : {}),
    });
});
