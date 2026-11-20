import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { AppError, ErrorCode } from "@/lib/errors";
import { captureServerException } from "@/lib/posthog-server";
import { plaudRefreshUserToken } from "./auth";
import {
    isPlaudTokenRejection,
    PlaudClient,
    PlaudTokenRejection,
} from "./client";
import {
    backfillPlaudTokenExpiries,
    markPlaudConnectionInvalidated,
    persistRefreshedPlaudTokens,
} from "./persist-connection";
import { getPlaudTokenExpiries } from "./stored-expiries";

export const PLAUD_ACCESS_REFRESH_WINDOW_MS = 60 * 60 * 1000;

export type PlaudConnectionCredentials = Pick<
    typeof plaudConnections.$inferSelect,
    | "id"
    | "userId"
    | "bearerToken"
    | "refreshToken"
    | "accessExpiresAt"
    | "sessionExpiresAt"
    | "apiBase"
    | "workspaceId"
>;

/** Whether a known access-token expiry is within the refresh window. */
export function shouldRefreshPlaudAccessToken(
    accessExpiresAt: Date | null,
    now: Date = new Date(),
): boolean {
    return (
        accessExpiresAt !== null &&
        accessExpiresAt.getTime() - now.getTime() <=
            PLAUD_ACCESS_REFRESH_WINDOW_MS
    );
}

interface CreatePlaudClientOptions {
    /** Receives the bearer ciphertext selected after a successful refresh. */
    onTokensStored?: (bearerToken: string) => void;
    /** Lets sync surface a rejected refresh even inside a best-effort step. */
    onRefreshRejected?: (error: PlaudTokenRejection) => void;
}

/** Build a client that refreshes and saves credentials for this connection. */
export async function createPlaudClient(
    connection: PlaudConnectionCredentials,
    options: CreatePlaudClientOptions = {},
): Promise<PlaudClient> {
    const { id: connectionId, userId, apiBase, workspaceId } = connection;
    const { accessExpiresAt, sessionExpiresAt } =
        getPlaudTokenExpiries(connection);
    if (!connection.accessExpiresAt && accessExpiresAt) {
        try {
            await backfillPlaudTokenExpiries({
                userId,
                connectionId,
                bearerToken: connection.bearerToken,
                accessExpiresAt,
                sessionExpiresAt,
            });
        } catch {
            console.warn("[plaud] failed to backfill token expiries");
        }
    }

    if (!connection.refreshToken) {
        return new PlaudClient(
            decrypt(connection.bearerToken),
            apiBase,
            workspaceId,
            { bearerCiphertext: connection.bearerToken },
        );
    }

    let storedRefreshToken = connection.refreshToken;
    let bearerToken = connection.bearerToken;
    let sessionEnd = sessionExpiresAt;
    const refresh = async () => {
        if (sessionEnd && sessionEnd.getTime() <= Date.now()) {
            throw new AppError(
                ErrorCode.PLAUD_INVALID_TOKEN,
                "Your Plaud sign-in has ended. Reconnect your Plaud account.",
                401,
                { reason: "session_expired" },
            );
        }

        const expectedRefreshToken = storedRefreshToken;
        const refreshToken = decrypt(expectedRefreshToken);
        const tokens = await plaudRefreshUserToken(refreshToken, apiBase);
        let accessToken = tokens.accessToken;
        let saved: Awaited<ReturnType<typeof persistRefreshedPlaudTokens>>;
        try {
            saved = await persistRefreshedPlaudTokens({
                userId,
                connectionId,
                storedRefreshToken: expectedRefreshToken,
                tokens: {
                    ...tokens,
                    refreshToken: tokens.refreshToken ?? refreshToken,
                },
            });
            if (!saved) {
                const [current] = await db
                    .select({
                        bearerToken: plaudConnections.bearerToken,
                        refreshToken: plaudConnections.refreshToken,
                        sessionExpiresAt: plaudConnections.sessionExpiresAt,
                    })
                    .from(plaudConnections)
                    .where(
                        and(
                            eq(plaudConnections.id, connectionId),
                            eq(plaudConnections.userId, userId),
                            eq(plaudConnections.apiBase, apiBase),
                            isNull(plaudConnections.invalidatedAt),
                        ),
                    )
                    .limit(1);
                if (
                    current?.refreshToken &&
                    current.refreshToken !== expectedRefreshToken
                ) {
                    saved = { ...current, refreshToken: current.refreshToken };
                    accessToken = decrypt(current.bearerToken);
                }
            }
        } catch {
            console.error("[plaud] failed to store refreshed tokens");
            captureServerException(new Error("plaud_refresh_persist_failed"), {
                source: "plaud",
                distinctId: userId,
                reason: "refresh_persist_failed",
            });
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Could not save refreshed Plaud credentials. Please try again later.",
                502,
            );
        }
        if (!saved) {
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "The Plaud connection changed during refresh. Please try again.",
                502,
            );
        }

        storedRefreshToken = saved.refreshToken;
        bearerToken = saved.bearerToken;
        sessionEnd = saved.sessionExpiresAt ?? sessionEnd;
        options.onTokensStored?.(bearerToken);
        return {
            accessToken,
            bearerCiphertext: bearerToken,
        };
    };

    const refreshUserToken = async () => {
        const rejectedCiphertext = bearerToken;
        try {
            return await refresh();
        } catch (error) {
            if (!isPlaudTokenRejection(error)) throw error;
            const rejection = new PlaudTokenRejection(
                rejectedCiphertext,
                error,
            );
            if (options.onRefreshRejected) {
                options.onRefreshRejected(rejection);
            } else {
                try {
                    await markPlaudConnectionInvalidated({
                        userId,
                        connectionId,
                        bearerToken: rejectedCiphertext,
                    });
                } catch {
                    console.error(
                        "[plaud] failed to mark the connection as invalidated",
                    );
                }
            }
            throw rejection;
        }
    };

    let userToken: string | undefined;
    if (shouldRefreshPlaudAccessToken(accessExpiresAt)) {
        try {
            userToken = (await refreshUserToken()).accessToken;
        } catch (err) {
            if (
                isPlaudTokenRejection(err) ||
                !accessExpiresAt ||
                accessExpiresAt.getTime() <= Date.now()
            ) {
                throw err;
            }
            console.warn(
                "[plaud] early token refresh failed, using the current access token",
            );
        }
    }

    return new PlaudClient(
        userToken ?? decrypt(bearerToken),
        apiBase,
        workspaceId,
        { bearerCiphertext: bearerToken, refreshUserToken },
    );
}
