import type { Account, OAuth2Tokens, OAuth2UserInfo } from "better-auth";
import { APIError } from "better-auth/api";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { accounts, sessions, users } from "@/db/schema";
import { recordAccessState } from "@/lib/authz/access-state";
import {
    authRequestStartedAt,
    currentLoginGrant,
    setLoginGrant,
} from "@/lib/authz/login-grant";
import { orderedCapabilities } from "@/lib/authz/policy";
import { storeSessionCredential } from "@/lib/authz/session-access";
import { env } from "@/lib/env";
import { getClaimsProvider, isIdpAuthorization } from "@/lib/identity/factory";
import { IdentityProviderError } from "@/lib/identity/ports";
import { ensureMailbox } from "@/lib/mail/addresses";
import { issuerMetadata } from "@/lib/mcp/config";
import { recordSsoUserInAlmanac } from "@/lib/sso/almanac";
import {
    SSO_ACCESS_DENIED_ERROR,
    SSO_ISSUER_MISMATCH_ERROR,
    SSO_ORG_ACCOUNT_ERROR,
    SSO_PROVIDER_ID,
    SSO_TOKEN_INVALID_ERROR,
    SSO_UNAVAILABLE_ERROR,
} from "@/lib/sso/constants";
import {
    type ProviderTokens,
    SsoTokenError,
    verifyIdToken,
    verifyWebAccessToken,
} from "@/lib/sso/tokens";

/** A newer access decision superseded this callback's provider response. */
export class SupersededSignInError extends Error {}

async function refuseOrgAccount(userId: string): Promise<void> {
    const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (row?.role === "org") {
        throw APIError.from("FORBIDDEN", {
            code: SSO_ORG_ACCOUNT_ERROR,
            message: "The organization account cannot sign in",
        });
    }
}

/** Send the browser back to the login page with `code`, before anything is stored. */
function refuseLogin(code: string): never {
    throw new APIError("FOUND", undefined, {
        location: `${env.APP_URL}/login?error=${encodeURIComponent(code)}`,
    });
}

/** The issuer a sign-in vouches for: the verified grant's, else the realm's. */
async function signInIssuer(): Promise<string | null> {
    const grant = currentLoginGrant();
    if (grant) return grant.identity.issuer;
    try {
        return (await issuerMetadata()).issuer;
    } catch {
        return null;
    }
}

/**
 * The user info of a sign-in with identity-provider authorization, from
 * verified tokens only: the ID token (signature, issuer, audience) for who,
 * the web client's access token for the capabilities. A person without
 * `use` is sent back to the login page before any account or session is
 * written; so is any token that does not verify.
 */
export async function verifySsoLogin(
    tokens: OAuth2Tokens,
): Promise<OAuth2UserInfo> {
    if (!tokens.idToken || !tokens.accessToken) {
        refuseLogin(SSO_TOKEN_INVALID_ERROR);
    }
    try {
        const { payload: idClaims, issuer } = await verifyIdToken(
            tokens.idToken,
        );
        const provider = getClaimsProvider();
        const identity = provider.identityFromIdToken(issuer, idClaims);
        const { payload: accessClaims } = await verifyWebAccessToken(
            tokens.accessToken,
        );
        if (!identity || accessClaims.sub !== identity.subject) {
            refuseLogin(SSO_TOKEN_INVALID_ERROR);
        }
        const capabilities = provider.capabilitiesFromAccessToken(accessClaims);
        if (!capabilities.has("use")) refuseLogin(SSO_ACCESS_DENIED_ERROR);

        const providerTokens: ProviderTokens = {
            accessToken: tokens.accessToken,
            accessTokenExpiresAt:
                tokens.accessTokenExpiresAt ??
                new Date(Number(accessClaims.exp) * 1000),
            refreshToken: tokens.refreshToken ?? null,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
            idToken: tokens.idToken,
        };
        setLoginGrant({
            identity,
            capabilities: orderedCapabilities(capabilities),
            tokens: providerTokens,
        });
        const info: OAuth2UserInfo = {
            id: identity.subject,
            email: identity.email,
            emailVerified: identity.emailVerified,
            name: identity.name ?? identity.email ?? undefined,
        };
        return { ...idClaims, ...info };
    } catch (error) {
        if (error instanceof SsoTokenError) {
            console.warn(`[sso] refused a sign-in: ${error.message}`);
            refuseLogin(SSO_TOKEN_INVALID_ERROR);
        }
        if (error instanceof IdentityProviderError) {
            console.warn(`[sso] could not verify a sign-in: ${error.kind}`);
            refuseLogin(SSO_UNAVAILABLE_ERROR);
        }
        throw error;
    }
}

/**
 * Profile mapping for the identity provider. The email follows the provider
 * on every login, except onto an address another Riffado account holds:
 * that account is someone else's, so the user keeps their current address.
 */
export async function mapSsoProfile(
    profile: Record<string, unknown>,
): Promise<{ email?: string }> {
    const subject = profile.sub ?? profile.id;
    const email =
        typeof profile.email === "string" ? profile.email.toLowerCase() : null;
    if (typeof subject !== "string" || !email) return {};

    const [linked] = await db
        .select({ userId: users.id, email: users.email })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.userId))
        .where(
            and(
                eq(accounts.providerId, SSO_PROVIDER_ID),
                eq(accounts.accountId, subject),
            ),
        )
        .limit(1);
    if (!linked || linked.email === email) return {};

    const [holder] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, linked.userId)))
        .limit(1);
    if (!holder) return {};
    console.warn(
        "[sso] identity provider email belongs to another account; keeping the current one",
    );
    return { email: linked.email };
}

/**
 * Before an identity is attached to a user: never to the organization
 * account, never to a user already bound to another issuer, and without
 * the provider's tokens (the session's credential keeps those, encrypted).
 * The account is bound to the issuer that vouched for it.
 */
export async function prepareSsoAccount(account: {
    userId: string;
    providerId: string;
}): Promise<{ data: Partial<Account> & { issuer?: string } } | undefined> {
    if (account.providerId !== SSO_PROVIDER_ID) return undefined;
    await refuseOrgAccount(account.userId);
    const issuer = await signInIssuer();
    if (issuer) {
        const [other] = await db
            .select({ issuer: accounts.issuer })
            .from(accounts)
            .where(
                and(
                    eq(accounts.userId, account.userId),
                    eq(accounts.providerId, SSO_PROVIDER_ID),
                    ne(accounts.issuer, issuer),
                ),
            )
            .limit(1);
        if (other) {
            throw APIError.from("FORBIDDEN", {
                code: SSO_ISSUER_MISMATCH_ERROR,
                message: "This account is bound to another identity provider",
            });
        }
    }
    return {
        data: {
            accessToken: null,
            refreshToken: null,
            idToken: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            ...(issuer ? { issuer } : {}),
        },
    };
}

async function linkedAccountOf(userId: string) {
    const [row] = await db
        .select({
            id: accounts.id,
            subject: accounts.accountId,
            issuer: accounts.issuer,
        })
        .from(accounts)
        .where(
            and(
                eq(accounts.userId, userId),
                eq(accounts.providerId, SSO_PROVIDER_ID),
            ),
        )
        .limit(1);
    return row ?? null;
}

/**
 * Before a session starts: the organization account has no interactive
 * login; an account bound to another issuer does not sign in through this
 * one; with identity-provider authorization only a verified grant for this
 * very account starts a session.
 */
export async function guardSsoSession(session: {
    userId: string;
}): Promise<void> {
    await refuseOrgAccount(session.userId);
    const account = await linkedAccountOf(session.userId);
    const issuer = await signInIssuer();
    if (account?.issuer && issuer && account.issuer !== issuer) {
        throw APIError.from("FORBIDDEN", {
            code: SSO_ISSUER_MISMATCH_ERROR,
            message: "This account is bound to another identity provider",
        });
    }
    if (!isIdpAuthorization()) return;
    const grant = currentLoginGrant();
    if (!grant || !account || grant.identity.subject !== account.subject) {
        throw APIError.from("FORBIDDEN", {
            code: SSO_ACCESS_DENIED_ERROR,
            message: "No verified access for this sign-in",
        });
    }
}

/**
 * After a session started: its provider credential is stored (identity-
 * provider authorization), a legacy account is bound to its issuer, and
 * the person goes into the Almanac. Only the Almanac and the mailbox are
 * best effort.
 */
export async function afterSsoSession(session: {
    id: string;
    userId: string;
}): Promise<void> {
    const grant = currentLoginGrant();
    const account = await linkedAccountOf(session.userId);
    const issuer = await signInIssuer();
    if (account && !account.issuer && issuer) {
        await db
            .update(accounts)
            .set({ issuer, updatedAt: new Date() })
            .where(eq(accounts.id, account.id));
    }
    if (isIdpAuthorization() && grant) {
        const stored = await db.transaction(async (tx) => {
            const current = await recordAccessState(
                {
                    userId: session.userId,
                    issuer: grant.identity.issuer,
                    subject: grant.identity.subject,
                    capabilities: grant.capabilities,
                    source: "login",
                    expectedUpdatedBefore: authRequestStartedAt(),
                },
                tx,
            );
            if (!current) return false;
            await storeSessionCredential(
                {
                    sessionId: session.id,
                    userId: session.userId,
                    issuer: grant.identity.issuer,
                    subject: grant.identity.subject,
                    capabilities: grant.capabilities,
                    authTime: grant.identity.authTime,
                    tokens: grant.tokens,
                },
                tx,
            );
            return true;
        });
        if (!stored) {
            await db.delete(sessions).where(eq(sessions.id, session.id));
            throw new SupersededSignInError();
        }
    }

    try {
        const [user] = await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
        if (!user) return;
        await recordSsoUserInAlmanac(user);
    } catch (error) {
        console.error("[sso] could not record the user in the Almanac:", error);
    }
    try {
        // Signing in keeps the user's addresses receiving, and gives them
        // their mailbox the first time once mail is on.
        await db
            .update(users)
            .set({ lastSsoLoginAt: new Date() })
            .where(eq(users.id, session.userId));
        await ensureMailbox(session.userId);
    } catch (error) {
        console.error("[mail] could not set up the user's mailbox:", error);
    }
}
