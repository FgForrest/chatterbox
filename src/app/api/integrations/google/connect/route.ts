import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_CONNECT_SCOPES,
    getGoogleIntegrationConfig,
    getGoogleOAuthConfig,
} from "@/lib/integrations/google/config";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import {
    buildAuthorizationUrl,
    createOAuthState,
    createPkcePair,
} from "@/lib/integrations/google/oauth";
import {
    GOOGLE_OAUTH_COOKIE,
    GOOGLE_OAUTH_COOKIE_PATH,
    GOOGLE_OAUTH_STATE_TTL_SECONDS,
    safeReturnTo,
    sealGoogleOAuthState,
} from "@/lib/integrations/google/oauth-state";

/** Starts connecting a Google account: a redirect to Google's consent. */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const url = new URL(request.url);
    const purpose =
        url.searchParams.get("purpose") === "calendar" ? "calendar" : "drive";
    const config =
        purpose === "calendar"
            ? getGoogleOAuthConfig()
            : getGoogleIntegrationConfig();
    if (!config) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The Google integration is not configured",
            404,
        );
    }
    const state = createOAuthState();
    const pkce = createPkcePair();
    const existing = await getGoogleConnectionStatus(session.user.id);
    const response = NextResponse.redirect(
        buildAuthorizationUrl({
            config,
            scopes:
                purpose === "calendar"
                    ? ["openid", "email", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]
                    : GOOGLE_CONNECT_SCOPES,
            state,
            codeChallenge: pkce.challenge,
            loginHint: existing?.email,
        }),
        302,
    );
    response.cookies.set(
        GOOGLE_OAUTH_COOKIE,
        sealGoogleOAuthState({
            state,
            verifier: pkce.verifier,
            userId: session.user.id,
            returnTo: safeReturnTo(
                url.searchParams.get("returnTo"),
                env.APP_URL ?? url.origin,
            ),
            expiresAt: Date.now() + GOOGLE_OAUTH_STATE_TTL_SECONDS * 1000,
            purpose,
        }),
        {
            httpOnly: true,
            // Lax: sent on Google's top-level redirect back, not cross-site
            // subrequests.
            sameSite: "lax",
            secure: (env.APP_URL ?? url.origin).startsWith("https:"),
            path: GOOGLE_OAUTH_COOKIE_PATH,
            maxAge: GOOGLE_OAUTH_STATE_TTL_SECONDS,
        },
    );
    return response;
});
