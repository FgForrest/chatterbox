import { env } from "@/lib/env";

/**
 * Whether sign-in goes through the OpenID Connect provider, and only through
 * it. Self-host only: hosted keeps email/password and its billing sign-up.
 */
export function isSsoEnabled(): boolean {
    return (
        !env.IS_HOSTED &&
        Boolean(
            env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET,
        )
    );
}

/** Whether OIDC variables are set on a deployment that ignores them. */
export function isSsoConfiguredButIgnored(): boolean {
    return env.IS_HOSTED && Boolean(env.OIDC_ISSUER_URL);
}

/** The OpenID discovery document of the configured issuer. */
export function ssoDiscoveryUrl(issuer: string): string {
    return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * better-auth endpoints that exist for passwords and local email addresses.
 * With single sign-on they are switched off on the server, not just hidden:
 * the identity provider owns credentials and email addresses.
 */
export const PASSWORD_AUTH_PATHS = [
    "/sign-in/email",
    "/sign-up/email",
    "/request-password-reset",
    "/reset-password",
    "/change-password",
    "/change-email",
    "/send-verification-email",
    "/verify-email",
    "/verify-password",
    "/link-social",
    "/unlink-account",
    "/oauth2/link",
] as const;
