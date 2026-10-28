import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
    GOOGLE_CONNECT_SCOPES,
    getGoogleIntegrationConfig,
    getGoogleOAuthConfig,
} from "@/lib/integrations/google/config";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import {
    calendarAndMeetConsentScopes,
    meetConsentScopes,
} from "@/lib/integrations/google/meet-consent";
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

type ConnectPurpose =
    | "drive"
    | "calendar"
    | "meet"
    | "calendar-meet"
    | "calendar-write";

function consentScopes(
    purpose: ConnectPurpose,
    existingScopes: string[],
): string[] {
    switch (purpose) {
        case "calendar-write":
            return [
                ...new Set([
                    "openid",
                    "email",
                    ...existingScopes,
                    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
                ]),
            ];
        case "meet":
            return meetConsentScopes(existingScopes);
        case "calendar-meet":
            return calendarAndMeetConsentScopes(
                existingScopes,
                GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
            );
        case "calendar":
            return ["openid", "email", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE];
        case "drive":
            return GOOGLE_CONNECT_SCOPES;
    }
}

/** Starts connecting a Google account: a redirect to Google's consent. */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const url = new URL(request.url);
    const requestedPurpose = url.searchParams.get("purpose");
    const purpose: ConnectPurpose =
        requestedPurpose === "calendar" ||
        requestedPurpose === "meet" ||
        requestedPurpose === "calendar-meet" ||
        requestedPurpose === "calendar-write"
            ? requestedPurpose
            : "drive";
    const config =
        purpose === "calendar" ||
        purpose === "meet" ||
        purpose === "calendar-meet" ||
        purpose === "calendar-write"
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
    if (
        (purpose === "meet" || purpose === "calendar-write") &&
        (!existing || existing.status !== "active")
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Connect a Google account before granting additional access",
            409,
        );
    }
    const response = NextResponse.redirect(
        buildAuthorizationUrl({
            config,
            scopes: consentScopes(purpose, existing?.scopes ?? []),
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
            expectedSubject:
                purpose === "meet" || purpose === "calendar-write"
                    ? existing?.subject
                    : undefined,
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
