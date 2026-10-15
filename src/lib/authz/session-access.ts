import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sessionIdpCredentials, sessions, users } from "@/db/schema";
import {
    accessStateVersion,
    recordAccessState,
} from "@/lib/authz/access-state";
import { type Capability, isCapability } from "@/lib/authz/catalog";
import { type ActorContext, LOCAL_MODE_CAPABILITIES } from "@/lib/authz/model";
import { expandGrants, orderedCapabilities } from "@/lib/authz/policy";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { getClaimsProvider, isIdpAuthorization } from "@/lib/identity/factory";
import { IdentityProviderError } from "@/lib/identity/ports";
import { isSsoEnabled } from "@/lib/sso/config";
import {
    type ProviderTokens,
    refreshProviderTokens,
    SsoTokenError,
    verifyWebAccessToken,
} from "@/lib/sso/tokens";

/** Why a session may not be used. */
export type SessionRefusal =
    | "ended"
    | "not-granted"
    | "unavailable"
    | "org-account";

/** The outcome of {@link sessionAccess}. */
export type SessionAccess =
    | { ok: true; actor: ActorContext; authTime: Date | null }
    | { ok: false; reason: SessionRefusal };

type CredentialRow = typeof sessionIdpCredentials.$inferSelect;

function maxAgeMs(): number {
    return env.AUTHZ_VERIFICATION_MAX_AGE * 1000;
}

function storedCapabilities(row: { capabilities: unknown }): Set<Capability> {
    return expandGrants<Capability>(
        Array.isArray(row.capabilities)
            ? row.capabilities.filter(isCapability)
            : [],
    );
}

function userActor(
    userId: string,
    row: CredentialRow,
    capabilities: Set<Capability>,
): ActorContext {
    return {
        kind: "user",
        actorId: userId,
        issuer: row.issuer,
        subject: row.subject,
        capabilities,
        clientId: env.OIDC_CLIENT_ID ?? null,
        clientPermissions: new Set(),
        verifiedAt: row.verifiedAt,
    };
}

/** Store a session's provider credential (encrypted) and its snapshot. */
export async function storeSessionCredential(
    input: {
        sessionId: string;
        userId: string;
        issuer: string;
        subject: string;
        capabilities: Capability[];
        authTime: Date | null;
        tokens: ProviderTokens;
    },
    executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
    const now = new Date();
    await executor.insert(sessionIdpCredentials).values({
        sessionId: input.sessionId,
        userId: input.userId,
        issuer: input.issuer,
        subject: input.subject,
        capabilities: input.capabilities,
        authTime: input.authTime,
        verifiedAt: now,
        accessToken: encryptText(input.tokens.accessToken),
        accessTokenExpiresAt: input.tokens.accessTokenExpiresAt,
        refreshToken: encryptText(input.tokens.refreshToken),
        refreshTokenExpiresAt: input.tokens.refreshTokenExpiresAt,
        createdAt: now,
        updatedAt: now,
    });
}

/** End one session; its credential goes with it. */
async function endSession(sessionId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Renew a stale snapshot with the session's refresh token, serialized on
 * the credential row so concurrent requests (on any instance) refresh once
 * and store the rotated token atomically.
 */
async function renew(
    sessionId: string,
    userId: string,
): Promise<SessionAccess> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .select()
            .from(sessionIdpCredentials)
            .where(
                and(
                    eq(sessionIdpCredentials.sessionId, sessionId),
                    eq(sessionIdpCredentials.userId, userId),
                ),
            )
            .for("update")
            .limit(1);
        if (!row) return { ok: false, reason: "ended" } as const;
        if (Date.now() - row.verifiedAt.getTime() < maxAgeMs()) {
            const capabilities = storedCapabilities(row);
            return capabilities.has("use")
                ? {
                      ok: true,
                      actor: userActor(userId, row, capabilities),
                      authTime: row.authTime,
                  }
                : ({ ok: false, reason: "not-granted" } as const);
        }
        const refreshToken = decryptText(row.refreshToken);
        if (!refreshToken) return { ok: false, reason: "ended" } as const;

        let tokens: ProviderTokens;
        let capabilities: Set<Capability>;
        const expectedUpdatedAt = await accessStateVersion(userId, tx);
        try {
            tokens = await refreshProviderTokens(refreshToken);
            const { payload } = await verifyWebAccessToken(tokens.accessToken);
            if (payload.sub !== row.subject) {
                throw new SsoTokenError("The renewed token names someone else");
            }
            capabilities =
                getClaimsProvider().capabilitiesFromAccessToken(payload);
        } catch (error) {
            if (
                error instanceof IdentityProviderError &&
                error.kind === "reauthentication_required"
            ) {
                return { ok: false, reason: "ended" } as const;
            }
            if (error instanceof SsoTokenError) {
                console.warn(`[authz] renewed token refused: ${error.message}`);
                return { ok: false, reason: "ended" } as const;
            }
            if (error instanceof IdentityProviderError) {
                console.warn(
                    `[authz] could not renew a session's access: ${error.kind}`,
                );
                return { ok: false, reason: "unavailable" } as const;
            }
            throw error;
        }

        const now = new Date();
        const updated = {
            capabilities: orderedCapabilities(capabilities),
            verifiedAt: now,
            accessToken: encryptText(tokens.accessToken),
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshToken: encryptText(tokens.refreshToken) ?? null,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            updatedAt: now,
        };
        await tx
            .update(sessionIdpCredentials)
            .set(updated)
            .where(eq(sessionIdpCredentials.sessionId, sessionId));
        const stored = await recordAccessState(
            {
                userId,
                issuer: row.issuer,
                subject: row.subject,
                capabilities,
                source: "refresh",
                expectedUpdatedAt,
            },
            tx,
        );
        if (!stored) {
            await tx
                .update(sessionIdpCredentials)
                .set({ verifiedAt: new Date(0) })
                .where(eq(sessionIdpCredentials.sessionId, sessionId));
            return { ok: false, reason: "unavailable" } as const;
        }
        if (!capabilities.has("use")) {
            return { ok: false, reason: "not-granted" } as const;
        }
        return {
            ok: true,
            actor: userActor(userId, { ...row, ...updated }, capabilities),
            authTime: row.authTime,
        } as const;
    });
}

const renewing = new Map<string, Promise<SessionAccess>>();

/**
 * {@link renew}, joined by the requests of the same session this process
 * is already renewing: one of them waits on the credential row's lock,
 * not one per parallel request.
 */
function renewOnce(sessionId: string, userId: string): Promise<SessionAccess> {
    const key = `${sessionId}\u0000${userId}`;
    let pending = renewing.get(key);
    if (!pending) {
        pending = renew(sessionId, userId).finally(() => {
            renewing.delete(key);
        });
        renewing.set(key, pending);
    }
    return pending;
}

/**
 * Whether a signed-in session may be used now, and as whom.
 *
 * Local mode: everybody may use the application; the organization account
 * is `local-org`. Identity-provider mode: the session's snapshot while it
 * is fresh, else renewed with its refresh token. A session the provider
 * ended, or whose person lost `use`, is ended here (on every instance,
 * since it lives in the database); a provider that cannot be asked means
 * no access now, never the stale snapshot. The organization account never
 * has an interactive session under single sign-on.
 */
export async function sessionAccess(session: {
    id: string;
    userId: string;
}): Promise<SessionAccess> {
    const [user] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
    if (!user) return { ok: false, reason: "ended" };
    if (user.role === "org" && isSsoEnabled()) {
        await endSession(session.id);
        return { ok: false, reason: "org-account" };
    }

    if (!isIdpAuthorization()) {
        return {
            ok: true,
            authTime: null,
            actor: {
                kind: user.role === "org" ? "local-org" : "user",
                actorId: session.userId,
                issuer: null,
                subject: null,
                capabilities: LOCAL_MODE_CAPABILITIES,
                clientId: null,
                clientPermissions: new Set(),
                verifiedAt: null,
            },
        };
    }

    const [row] = await db
        .select()
        .from(sessionIdpCredentials)
        .where(
            and(
                eq(sessionIdpCredentials.sessionId, session.id),
                eq(sessionIdpCredentials.userId, session.userId),
            ),
        )
        .limit(1);
    if (!row) {
        await endSession(session.id);
        return { ok: false, reason: "ended" };
    }

    let access: SessionAccess;
    if (Date.now() - row.verifiedAt.getTime() < maxAgeMs()) {
        const capabilities = storedCapabilities(row);
        access = capabilities.has("use")
            ? {
                  ok: true,
                  actor: userActor(session.userId, row, capabilities),
                  authTime: row.authTime,
              }
            : { ok: false, reason: "not-granted" };
    } else {
        access = await renewOnce(session.id, session.userId);
    }
    if (
        !access.ok &&
        (access.reason === "ended" || access.reason === "not-granted")
    ) {
        await endSession(session.id);
    }
    return access;
}

/**
 * The provider access token of a session, renewed when it is about to
 * expire; for calls made on the signed-in person's behalf (access
 * management). Never returned to a browser.
 */
export async function sessionProviderToken(session: {
    id: string;
    userId: string;
}): Promise<string> {
    const read = async () => {
        const [row] = await db
            .select()
            .from(sessionIdpCredentials)
            .where(
                and(
                    eq(sessionIdpCredentials.sessionId, session.id),
                    eq(sessionIdpCredentials.userId, session.userId),
                ),
            )
            .limit(1);
        return row ?? null;
    };
    const row = await read();
    if (!row) {
        throw new IdentityProviderError(
            "reauthentication_required",
            "The sign-in has no provider credential",
        );
    }
    if (row.accessTokenExpiresAt.getTime() - Date.now() > 30_000) {
        return decryptText(row.accessToken);
    }
    await db
        .update(sessionIdpCredentials)
        .set({ verifiedAt: new Date(0) })
        .where(eq(sessionIdpCredentials.sessionId, session.id));
    const renewed = await sessionAccess(session);
    if (!renewed.ok) {
        throw new IdentityProviderError(
            renewed.reason === "unavailable"
                ? "unavailable"
                : "reauthentication_required",
            "The sign-in could not be renewed",
        );
    }
    const fresh = await read();
    if (!fresh) {
        throw new IdentityProviderError(
            "reauthentication_required",
            "The sign-in ended",
        );
    }
    return decryptText(fresh.accessToken);
}
