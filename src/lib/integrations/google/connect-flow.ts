import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE,
    GOOGLE_DRIVE_FILE_SCOPE,
    getGoogleIntegrationConfig,
    getGoogleOAuthConfig,
} from "./config";
import {
    getGoogleConnectionStatus,
    saveGoogleConnection,
    saveMeetGrant,
} from "./connection";
import { GOOGLE_MEET_READ_SCOPE } from "./meet-consent";
import { exchangeAuthorizationCode, readIdTokenClaims } from "./oauth";
import { openGoogleOAuthState } from "./oauth-state";

export type GoogleConnectOutcome =
    | "connected"
    | "denied"
    | "invalid_state"
    | "domain_not_allowed"
    | "email_not_verified"
    | "missing_scope"
    | "missing_calendar_scope"
    | "missing_meet_scope"
    | "account_mismatch"
    | "missing_existing_scope"
    | "failed";

export interface GoogleConnectResult {
    outcome: GoogleConnectOutcome;
    /** Where to send the browser; a same-origin path. */
    returnTo: string;
}

/**
 * Finishes connecting a Google account after Google redirects back.
 *
 * The sealed cookie must match the `state` Google echoes and the user now
 * signed in, so a callback started by someone else cannot attach their
 * account to this user. Workspace domain and scopes are checked before
 * anything is stored: granular consent lets a user untick Drive.
 */
export async function completeGoogleConnect(input: {
    userId: string;
    sealedState: string | undefined;
    params: URLSearchParams;
    fetchImpl?: typeof fetch;
}): Promise<GoogleConnectResult> {
    const sealed = openGoogleOAuthState(input.sealedState);
    const state = input.params.get("state");
    if (!sealed || !state || sealed.state !== state) {
        return { outcome: "invalid_state", returnTo: "/dashboard" };
    }
    const returnTo = sealed.returnTo;
    if (sealed.userId !== input.userId) {
        return { outcome: "invalid_state", returnTo };
    }
    if (input.params.get("error")) return { outcome: "denied", returnTo };
    const code = input.params.get("code");
    const config =
        sealed.purpose === "calendar" ||
        sealed.purpose === "meet" ||
        sealed.purpose === "calendar-meet" ||
        sealed.purpose === "calendar-write"
            ? getGoogleOAuthConfig()
            : getGoogleIntegrationConfig();
    if (!code || !config) return { outcome: "failed", returnTo };

    try {
        const tokens = await exchangeAuthorizationCode(
            { config, code, codeVerifier: sealed.verifier },
            input.fetchImpl,
        );
        if (!tokens.idToken) return { outcome: "failed", returnTo };
        const claims = readIdTokenClaims(tokens.idToken);
        if (!claims.emailVerified) {
            return { outcome: "email_not_verified", returnTo };
        }
        if (
            config.workspaceDomains.length > 0 &&
            !config.workspaceDomains.includes(claims.hostedDomain ?? "")
        ) {
            return { outcome: "domain_not_allowed", returnTo };
        }
        const needsCalendar =
            sealed.purpose === "calendar" || sealed.purpose === "calendar-meet";
        const needsMeet =
            sealed.purpose === "meet" || sealed.purpose === "calendar-meet";
        const needsDrive =
            sealed.purpose === "drive" || sealed.purpose === undefined;
        if (
            needsCalendar &&
            !tokens.scopes.includes(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE)
        ) {
            return { outcome: "missing_calendar_scope", returnTo };
        }
        if (
            sealed.purpose === "calendar-write" &&
            !tokens.scopes.includes(GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE)
        )
            return { outcome: "missing_calendar_scope", returnTo };
        if (needsMeet && !tokens.scopes.includes(GOOGLE_MEET_READ_SCOPE)) {
            return { outcome: "missing_meet_scope", returnTo };
        }
        if (needsDrive && !tokens.scopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
            return { outcome: "missing_scope", returnTo };
        }
        const existing = await getGoogleConnectionStatus(input.userId);
        if (
            (sealed.purpose === "calendar" ||
                sealed.purpose === "meet" ||
                sealed.purpose === "calendar-meet" ||
                sealed.purpose === "calendar-write") &&
            existing &&
            existing.subject !== claims.subject
        ) {
            return { outcome: "account_mismatch", returnTo };
        }
        if (
            (sealed.purpose === "meet" ||
                sealed.purpose === "calendar-write") &&
            (!existing ||
                existing.status !== "active" ||
                existing.subject !== sealed.expectedSubject ||
                claims.subject !== sealed.expectedSubject)
        ) {
            return { outcome: "account_mismatch", returnTo };
        }
        if (
            existing?.subject === claims.subject &&
            existing.scopes.some((scope) => !tokens.scopes.includes(scope))
        ) {
            return { outcome: "missing_existing_scope", returnTo };
        }
        if (sealed.purpose === "meet" || sealed.purpose === "calendar-write") {
            const updated = await saveMeetGrant(
                input.userId,
                sealed.expectedSubject ?? "",
                existing?.scopes ?? [],
                claims,
                tokens,
            );
            if (!updated) return { outcome: "failed", returnTo };
        } else {
            await saveGoogleConnection(input.userId, claims, tokens);
        }
    } catch (error) {
        console.error("[google] connecting an account failed:", error);
        return { outcome: "failed", returnTo };
    }
    // Exports paused by a lost connection pick up where they stopped.
    if (sealed.purpose === "drive" || sealed.purpose === undefined) {
        await enqueueExportPlansForUser(input.userId).catch((error) => {
            console.error("[google] could not re-plan exports:", error);
        });
    }
    return { outcome: "connected", returnTo };
}

/** `returnTo` with the outcome appended as `?google=<outcome>`. */
export function returnUrlWithOutcome(
    returnTo: string,
    outcome: GoogleConnectOutcome,
    appUrl: string,
): URL {
    const url = new URL(returnTo, appUrl);
    url.searchParams.set("google", outcome);
    return url;
}
