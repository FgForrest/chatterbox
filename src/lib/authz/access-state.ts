import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { lockOrgTree } from "@/db/queries/organization-tree";
import { cancelUserFolderRequests } from "@/db/queries/restricted-folder-access-requests";
import { accounts, userAccessStates } from "@/db/schema";
import { type Capability, isCapability } from "@/lib/authz/catalog";
import { expandGrants, orderedCapabilities } from "@/lib/authz/policy";
import { env } from "@/lib/env";
import { getAccessVerifier } from "@/lib/identity/factory";
import {
    type AccessVerification,
    IdentityProviderError,
} from "@/lib/identity/ports";
import { isOrgScopeVisible } from "@/lib/org/config";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";

type Executor = Pick<typeof db, "insert" | "update" | "execute">;

export type AccessStateSource =
    | "login"
    | "refresh"
    | "verifier"
    | "access-change";

/** Record what the identity provider said about a person's access. */
export async function recordAccessState(
    input: {
        userId: string;
        issuer: string;
        subject: string;
        capabilities: Iterable<Capability>;
        status?: "active" | "disabled" | "missing";
        source: AccessStateSource;
        expectedUpdatedAt?: Date | null;
        expectedUpdatedBefore?: Date;
    },
    executor: Executor = db,
): Promise<boolean> {
    const now = new Date();
    const values = {
        issuer: input.issuer,
        subject: input.subject,
        capabilities: orderedCapabilities(input.capabilities),
        status: input.status ?? "active",
        verifiedAt: now,
        source: input.source,
        updatedAt: now,
    };
    const cancelRequests =
        isOrgScopeVisible() &&
        (values.status !== "active" || !values.capabilities.includes("use"));
    if (cancelRequests && executor === db)
        return db.transaction((tx) =>
            recordAccessState(
                { ...input, capabilities: values.capabilities },
                tx,
            ),
        );
    if (cancelRequests) await lockOrgTree(executor);
    const insert = executor
        .insert(userAccessStates)
        .values({ userId: input.userId, ...values });
    const written = await (input.expectedUpdatedAt === null
        ? insert.onConflictDoNothing()
        : insert.onConflictDoUpdate({
              target: userAccessStates.userId,
              set: {
                  ...values,
                  updatedAt: sql`greatest(${now.toISOString()}::timestamp, ${userAccessStates.updatedAt} + interval '1 millisecond')`,
              },
              setWhere: input.expectedUpdatedAt
                  ? eq(userAccessStates.updatedAt, input.expectedUpdatedAt)
                  : input.expectedUpdatedBefore
                    ? lt(
                          userAccessStates.updatedAt,
                          input.expectedUpdatedBefore,
                      )
                    : undefined,
          })
    ).returning({ userId: userAccessStates.userId });
    if (written.length && cancelRequests)
        await cancelUserFolderRequests(executor, input.userId);
    return written.length > 0;
}

/**
 * Read the version to which an in-flight provider verification belongs.
 * Inside a transaction pass it, so the read takes no second connection.
 */
export async function accessStateVersion(
    userId: string,
    executor: Pick<typeof db, "select"> = db,
): Promise<Date | null> {
    const [state] = await executor
        .select({ updatedAt: userAccessStates.updatedAt })
        .from(userAccessStates)
        .where(eq(userAccessStates.userId, userId))
        .limit(1);
    return state?.updatedAt ?? null;
}

/** A holder's access as API keys and MCP calls check it. */
export type HolderAccess =
    | { ok: true; capabilities: Set<Capability>; verifiedAt: Date }
    | {
          ok: false;
          reason: "not-granted" | "disabled" | "unverifiable" | "unavailable";
      };

function maxAgeMs(): number {
    return env.AUTHZ_VERIFICATION_MAX_AGE * 1000;
}

function capabilitiesOf(stored: unknown): Set<Capability> {
    return expandGrants<Capability>(
        Array.isArray(stored) ? stored.filter(isCapability) : [],
    );
}

async function storedAccessState(
    userId: string,
    executor: Pick<typeof db, "select"> = db,
) {
    const [state] = await executor
        .select()
        .from(userAccessStates)
        .where(eq(userAccessStates.userId, userId))
        .limit(1);
    return state;
}

function freshStoredAccess(
    state: typeof userAccessStates.$inferSelect | undefined,
): HolderAccess | null {
    if (!state || Date.now() - state.verifiedAt.getTime() >= maxAgeMs()) {
        return null;
    }
    if (state.status !== "active") return { ok: false, reason: "disabled" };
    const capabilities = capabilitiesOf(state.capabilities);
    return capabilities.has("use")
        ? { ok: true, capabilities, verifiedAt: state.verifiedAt }
        : { ok: false, reason: "not-granted" };
}

async function providerIdentity(
    userId: string,
    executor: Pick<typeof db, "select"> = db,
): Promise<{ issuer: string; subject: string } | null> {
    const [account] = await executor
        .select({ issuer: accounts.issuer, subject: accounts.accountId })
        .from(accounts)
        .where(
            and(
                eq(accounts.userId, userId),
                eq(accounts.providerId, SSO_PROVIDER_ID),
            ),
        )
        .limit(1);
    if (!account?.issuer) return null;
    return { issuer: account.issuer, subject: account.subject };
}

/**
 * The verified access of a credential's holder (AUTHZ_MODE=idp): the last
 * verification while it is younger than AUTHZ_VERIFICATION_MAX_AGE,
 * otherwise a fresh one from the access verifier. Without a verifier, or
 * with the provider unreachable, a stale verification is never used:
 * `unverifiable` / `unavailable`. Read-only checks do not persist a fresh
 * verdict and reject concurrent changes to the stored access state.
 */
export async function holderAccess(
    userId: string,
    options: {
        readOnly?: boolean;
        executor?: Pick<typeof db, "select">;
        verify?: boolean;
    } = {},
): Promise<HolderAccess> {
    const state = await storedAccessState(userId, options.executor);
    const fresh = freshStoredAccess(state);
    if (fresh) return fresh;

    if (options.verify === false) return { ok: false, reason: "unverifiable" };
    const verifier = getAccessVerifier();
    const identity = await providerIdentity(userId, options.executor);
    if (!verifier || !identity) return { ok: false, reason: "unverifiable" };
    let verdict: Awaited<ReturnType<typeof verifier.verify>>;
    try {
        verdict = await verifier.verify(identity.subject);
    } catch (error) {
        if (error instanceof IdentityProviderError) {
            console.warn(
                `[authz] could not verify a holder's access: ${error.kind}`,
            );
            return { ok: false, reason: "unavailable" };
        }
        throw error;
    }
    if (options.readOnly) {
        const currentVersion = await accessStateVersion(
            userId,
            options.executor,
        );
        if (currentVersion?.getTime() !== state?.updatedAt.getTime()) {
            return { ok: false, reason: "unavailable" };
        }
    } else {
        const stored = await recordAccessState({
            userId,
            ...identity,
            capabilities:
                verdict.status === "active" ? verdict.capabilities : [],
            status: verdict.status,
            source: "verifier",
            expectedUpdatedAt: state?.updatedAt ?? null,
        });
        if (!stored) {
            const own = verdictAccess(verdict);
            // A denial this request verified never yields to a grant stored meanwhile.
            if (!own.ok) return own;
            return (
                freshStoredAccess(
                    await storedAccessState(userId, options.executor),
                ) ?? { ok: false, reason: "unavailable" }
            );
        }
    }
    return verdictAccess(verdict);
}

function verdictAccess(verdict: AccessVerification): HolderAccess {
    if (verdict.status !== "active") return { ok: false, reason: "disabled" };
    return verdict.capabilities.has("use")
        ? {
              ok: true,
              capabilities: verdict.capabilities,
              verifiedAt: new Date(),
          }
        : { ok: false, reason: "not-granted" };
}
