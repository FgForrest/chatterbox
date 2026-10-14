import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { lockAccessChange } from "@/db/queries/access-locks";
import {
    accessChangeLog,
    accounts,
    sessionIdpCredentials,
    sessions,
    users,
} from "@/db/schema";
import { recordAccessState } from "@/lib/authz/access-state";
import {
    CAPABILITIES,
    type Capability,
    isCapability,
} from "@/lib/authz/catalog";
import type { ActorContext } from "@/lib/authz/model";
import { mayManageAccess } from "@/lib/authz/policy";
import { sessionProviderToken } from "@/lib/authz/session-access";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    accessManagementFor,
    isIdpAuthorization,
} from "@/lib/identity/factory";
import {
    type AccessChange,
    type AccessManagementPort,
    IdentityProviderError,
    type InheritedSource,
    type SubjectAccess,
} from "@/lib/identity/ports";
import { issuerMetadata } from "@/lib/mcp/config";
import { SSO_PROVIDER_ID } from "@/lib/sso/constants";

/** The signed-in administrator, as the server established them. */
export interface AdminContext {
    actor: ActorContext;
    session: { id: string; userId: string };
    authTime: Date | null;
}

type Outcome = (typeof accessChangeLog.$inferInsert)["outcome"];
type Revocation = (typeof accessChangeLog.$inferInsert)["revocation"];

/** The Chatterbox account linked to a provider subject, if any. */
export interface LocalAccount {
    userId: string;
    email: string;
    name: string | null;
    lastSsoLoginAt: Date | null;
}

/** A row of the access list. */
export interface AccessRow {
    subject: string;
    username: string | null;
    email: string | null;
    name: string | null;
    enabled: boolean;
    effective: Capability[];
    managed: Capability[];
    local: LocalAccount | null;
}

/** The access of one subject, for the detail view and a change. */
export interface AccessDetail {
    subject: string;
    username: string | null;
    email: string | null;
    name: string | null;
    enabled: boolean;
    effective: Capability[];
    managed: Capability[];
    inherited: { capability: Capability; sources: InheritedSource[] }[];
    revision: string;
    local: LocalAccount | null;
    self: boolean;
}

/** What a change did, as the browser learns it. */
export interface AccessChangeOutcome {
    status: "applied" | "partial" | "noop";
    correlationId: string;
    applied: AccessChange;
    failed: { capability: Capability; error: string }[];
    stillEffective: { capability: Capability; sources: InheritedSource[] }[];
    revocation: Revocation;
    access: AccessDetail;
}

const MAX_PAGE = 50;

function forbidden(): AppError {
    return new AppError(
        ErrorCode.CAPABILITY_REQUIRED,
        "You are not an administrator of access to this application",
        403,
    );
}

/** Whether the settings show access management to this actor. */
export function accessManagementAvailable(actor: ActorContext | null): boolean {
    if (!actor || actor.kind !== "user" || !isIdpAuthorization()) return false;
    if (!mayManageAccess(actor)) return false;
    return Boolean(
        env.KEYCLOAK_GROUP_USE_ID &&
            env.KEYCLOAK_GROUP_CURATE_ID &&
            env.KEYCLOAK_GROUP_ACCESS_MANAGE_ID,
    );
}

/** Refuse anyone without `use` and `access.manage`, or without IdP authorization. */
export function assertAccessAdministrator(context: AdminContext): void {
    if (!isIdpAuthorization()) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Access is not managed in this application",
            404,
        );
    }
    if (context.actor.kind !== "user" || !mayManageAccess(context.actor)) {
        throw forbidden();
    }
}

function assertFreshAuthentication(context: AdminContext): void {
    const maxAge = env.AUTHZ_ADMIN_MAX_AUTH_AGE * 1000;
    if (!context.authTime || Date.now() - context.authTime.getTime() > maxAge) {
        throw new AppError(
            ErrorCode.REAUTHENTICATION_REQUIRED,
            "Sign in again to manage access",
            401,
        );
    }
}

function portFor(context: AdminContext): AccessManagementPort {
    const port = accessManagementFor(() =>
        sessionProviderToken(context.session),
    );
    if (!port) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Access is not managed in this application",
            404,
        );
    }
    return port;
}

/** The API error for a failed provider call. */
export function providerError(error: IdentityProviderError): AppError {
    console.error("[access] identity provider call failed", {
        kind: error.kind,
        status: error.status ?? null,
        message: error.message,
    });
    switch (error.kind) {
        case "forbidden":
            return new AppError(
                ErrorCode.PROVIDER_DENIED,
                "The identity provider refused this change for your account",
                403,
            );
        case "unauthorized":
        case "reauthentication_required":
            return new AppError(
                ErrorCode.REAUTHENTICATION_REQUIRED,
                "Sign in again to manage access",
                401,
            );
        case "not_found":
            return new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
        case "conflict":
            return new AppError(
                ErrorCode.CONFLICT,
                "The identity provider reported a conflict",
                409,
            );
        default:
            return new AppError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "The identity provider is unavailable. Try again shortly.",
                503,
            );
    }
}

async function localAccounts(
    subjects: string[],
): Promise<Map<string, LocalAccount>> {
    if (subjects.length === 0) return new Map();
    const issuer = await configuredIssuer();
    const rows = await db
        .select({
            subject: accounts.accountId,
            userId: users.id,
            email: users.email,
            name: users.name,
            lastSsoLoginAt: users.lastSsoLoginAt,
        })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.userId))
        .where(
            and(
                eq(accounts.providerId, SSO_PROVIDER_ID),
                inArray(accounts.accountId, subjects),
                issuer
                    ? or(eq(accounts.issuer, issuer), isNull(accounts.issuer))
                    : undefined,
            ),
        );
    return new Map(
        rows.map((row) => [
            row.subject,
            {
                userId: row.userId,
                email: row.email,
                name: row.name,
                lastSsoLoginAt: row.lastSsoLoginAt,
            },
        ]),
    );
}

/** The realm's issuer as tokens carry it (the discovery document's). */
async function configuredIssuer(): Promise<string | null> {
    try {
        return (await issuerMetadata()).issuer;
    } catch {
        return null;
    }
}

function detailOf(
    access: SubjectAccess,
    local: LocalAccount | null,
    context: AdminContext,
): AccessDetail {
    return {
        subject: access.subject.id,
        username: access.subject.username,
        email: access.subject.email,
        name: access.subject.name,
        enabled: access.subject.enabled,
        effective: access.effective,
        managed: access.managed,
        inherited: access.inherited,
        revision: access.revision,
        local,
        self: access.subject.id === context.actor.subject,
    };
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof IdentityProviderError) throw providerError(error);
        throw error;
    }
}

/** One page of the people the provider knows, with their access. */
export async function listAccess(
    context: AdminContext,
    query: { search?: string; page: number; pageSize: number },
): Promise<{ rows: AccessRow[]; hasMore: boolean }> {
    assertAccessAdministrator(context);
    const port = portFor(context);
    const max = Math.min(Math.max(query.pageSize, 1), MAX_PAGE);
    const page = await guarded(() =>
        port.listAccess({
            search: query.search?.trim() || undefined,
            first: Math.max(query.page, 0) * max,
            max,
        }),
    );
    const local = await localAccounts(
        page.entries.map((entry) => entry.subject.id),
    );
    return {
        rows: page.entries.map((entry) => ({
            subject: entry.subject.id,
            username: entry.subject.username,
            email: entry.subject.email,
            name: entry.subject.name,
            enabled: entry.subject.enabled,
            effective: entry.effective,
            managed: entry.managed,
            local: local.get(entry.subject.id) ?? null,
        })),
        hasMore: page.hasMore,
    };
}

/** The access of one subject. */
export async function getAccessDetail(
    context: AdminContext,
    subjectId: string,
): Promise<AccessDetail> {
    assertAccessAdministrator(context);
    const access = await guarded(() => portFor(context).getAccess(subjectId));
    if (!access)
        throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
    const local = (await localAccounts([subjectId])).get(subjectId) ?? null;
    return detailOf(access, local, context);
}

/** Parse a change request: catalog capabilities only, nothing provider-specific. */
export function parseAccessChange(body: unknown): {
    change: AccessChange;
    revision: string;
} {
    const input = (body ?? {}) as Record<string, unknown>;
    const list = (value: unknown): Capability[] | null => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || !value.every(isCapability)) return null;
        return CAPABILITIES.filter((capability) => value.includes(capability));
    };
    const add = list(input.add);
    const remove = list(input.remove);
    const allowed = new Set(["add", "remove", "revision"]);
    if (
        add === null ||
        remove === null ||
        typeof input.revision !== "string" ||
        !input.revision ||
        Object.keys(input).some((key) => !allowed.has(key)) ||
        add.some((capability) => remove.includes(capability)) ||
        add.length + remove.length === 0
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A change names capabilities to add or remove and the revision it was made against",
            400,
        );
    }
    return { change: { add, remove }, revision: input.revision };
}

async function audit(entry: {
    correlationId: string;
    context: AdminContext;
    subject: string;
    targetUserId: string | null;
    action: "change" | "revoke-sessions";
    requested: unknown;
    before?: SubjectAccess | null;
    after?: SubjectAccess | null;
    outcome: Outcome;
    revocation?: Revocation;
    error?: string | null;
}): Promise<void> {
    const snapshot = (access?: SubjectAccess | null) =>
        access
            ? {
                  enabled: access.subject.enabled,
                  effective: access.effective,
                  managed: access.managed,
                  inherited: access.inherited,
              }
            : null;
    try {
        await db.insert(accessChangeLog).values({
            correlationId: entry.correlationId,
            actorUserId: entry.context.actor.actorId,
            actorIssuer: entry.context.actor.issuer,
            actorSubject: entry.context.actor.subject,
            targetUserId: entry.targetUserId,
            targetIssuer: await configuredIssuer(),
            targetSubject: entry.subject,
            action: entry.action,
            requested: entry.requested,
            before: snapshot(entry.before),
            after: snapshot(entry.after),
            outcome: entry.outcome,
            revocation: entry.revocation ?? "not-needed",
            error: entry.error ?? null,
        });
    } catch (error) {
        console.error(
            `[access] audit write failed for ${entry.correlationId}:`,
            error instanceof Error ? error.message : error,
        );
        throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "The change could not be recorded",
            500,
            { correlationId: entry.correlationId },
        );
    }
}

/**
 * End the person's sessions here (every instance: they live in the
 * database) and ask the provider to end theirs. Returns how revocation
 * stands; never throws for a provider failure.
 */
async function revokeEverywhere(
    port: AccessManagementPort,
    subject: string,
    localUserId: string | null,
): Promise<Revocation> {
    if (localUserId) {
        await db.delete(sessions).where(eq(sessions.userId, localUserId));
    }
    if (!port.support.revokeSessions) return "pending";
    try {
        await port.revokeSessions(subject);
        return "done";
    } catch (error) {
        console.warn(
            `[access] provider session revocation failed: ${
                error instanceof IdentityProviderError ? error.kind : "error"
            }`,
        );
        return "pending";
    }
}

/** Make every session of the person renew its snapshot on its next request. */
async function invalidateSnapshots(localUserId: string | null): Promise<void> {
    if (!localUserId) return;
    await db
        .update(sessionIdpCredentials)
        .set({ verifiedAt: new Date(0) })
        .where(eq(sessionIdpCredentials.userId, localUserId));
}

/**
 * Change a person's access at the provider, on behalf of the signed-in
 * administrator, with the administrator's own provider token.
 *
 * Serialized per person and, for anything touching `use` or
 * `access.manage`, across all administrators. Under the lock the
 * administrator is re-verified at the provider and the person's access
 * re-read: a screen older than the provider's state is refused (`stale`),
 * a capability that removing the managed group would not take away is
 * refused (`inherited`), and nobody lowers their own `use` or
 * `access.manage`. After the write the access is read back; only that is
 * reported. Losing `use` ends the person's sessions here and at the
 * provider; any other change makes their sessions renew.
 */
export async function changeAccess(
    context: AdminContext,
    subjectId: string,
    request: { change: AccessChange; revision: string },
): Promise<AccessChangeOutcome> {
    assertAccessAdministrator(context);
    const correlationId = randomUUID();
    const local = (await localAccounts([subjectId])).get(subjectId) ?? null;
    const base = {
        correlationId,
        context,
        subject: subjectId,
        targetUserId: local?.userId ?? null,
        action: "change" as const,
        requested: request.change,
    };

    try {
        assertFreshAuthentication(context);
    } catch (error) {
        await audit({ ...base, outcome: "reauth-required" });
        throw error;
    }

    const lowersOwn =
        subjectId === context.actor.subject &&
        request.change.remove.some(
            (capability) =>
                capability === "use" || capability === "access.manage",
        );
    if (lowersOwn) {
        await audit({ ...base, outcome: "self-lockout" });
        throw new AppError(
            ErrorCode.ACCESS_LOCKOUT,
            "You cannot take away your own access or administration",
            409,
        );
    }

    const port = portFor(context);
    const affectsAdministrators = [
        ...request.change.add,
        ...request.change.remove,
    ].some(
        (capability) => capability === "use" || capability === "access.manage",
    );

    try {
        return await db.transaction(async (tx) => {
            await lockAccessChange(tx, subjectId, affectsAdministrators);

            const actorNow = context.actor.subject
                ? await port.getAccess(context.actor.subject)
                : null;
            if (
                !actorNow?.subject.enabled ||
                !actorNow.effective.includes("use") ||
                !actorNow.effective.includes("access.manage")
            ) {
                await audit({ ...base, outcome: "denied" });
                throw forbidden();
            }

            const before = await port.getAccess(subjectId);
            if (!before) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Person not found",
                    404,
                );
            }
            if (before.revision !== request.revision) {
                await audit({ ...base, before, outcome: "stale" });
                throw new AppError(
                    ErrorCode.ACCESS_STALE,
                    "This person's access changed meanwhile. Reload and try again.",
                    409,
                    { access: detailOf(before, local, context) },
                );
            }
            const inherited = before.inherited.filter(({ capability }) =>
                request.change.remove.includes(capability),
            );
            if (inherited.length > 0) {
                await audit({ ...base, before, outcome: "inherited" });
                throw new AppError(
                    ErrorCode.ACCESS_INHERITED,
                    "Part of this access is granted elsewhere at the identity provider and cannot be switched off here",
                    409,
                    { inherited },
                );
            }

            const result = await port.changeAccess(subjectId, request.change);
            const after = result.after;
            const lostUse =
                before.effective.includes("use") &&
                !after.effective.includes("use");
            const changed =
                result.applied.add.length + result.applied.remove.length > 0;

            let revocation: Revocation = "not-needed";
            if (local) {
                await recordAccessState({
                    userId: local.userId,
                    issuer: (await configuredIssuer()) ?? "",
                    subject: subjectId,
                    capabilities: after.subject.enabled ? after.effective : [],
                    status: after.subject.enabled ? "active" : "disabled",
                    source: "access-change",
                });
            }
            if (lostUse) {
                revocation = await revokeEverywhere(
                    port,
                    subjectId,
                    local?.userId ?? null,
                );
            } else if (changed) {
                await invalidateSnapshots(local?.userId ?? null);
            }

            await audit({
                ...base,
                before,
                after,
                outcome:
                    result.status === "partial"
                        ? "partial"
                        : result.stillEffective.length > 0
                          ? "inherited"
                          : result.status,
                revocation,
                error:
                    result.failed.length > 0
                        ? result.failed
                              .map((f) => `${f.capability}:${f.error}`)
                              .join(", ")
                        : null,
            });
            return {
                status: result.status,
                correlationId,
                applied: result.applied,
                failed: result.failed,
                stillEffective: result.stillEffective,
                revocation,
                access: detailOf(after, local, context),
            };
        });
    } catch (error) {
        if (error instanceof IdentityProviderError) {
            await audit({
                ...base,
                outcome:
                    error.kind === "forbidden" ? "provider-denied" : "error",
                error: error.kind,
            });
            throw providerError(error);
        }
        throw error;
    }
}

/** End a person's sessions again, here and at the provider (retry). */
export async function revokeSessions(
    context: AdminContext,
    subjectId: string,
): Promise<{ revocation: Revocation; correlationId: string }> {
    assertAccessAdministrator(context);
    assertFreshAuthentication(context);
    if (subjectId === context.actor.subject) {
        throw new AppError(
            ErrorCode.ACCESS_LOCKOUT,
            "You cannot end your own sessions here",
            409,
        );
    }
    const correlationId = randomUUID();
    const local = (await localAccounts([subjectId])).get(subjectId) ?? null;
    const revocation = await revokeEverywhere(
        portFor(context),
        subjectId,
        local?.userId ?? null,
    );
    await audit({
        correlationId,
        context,
        subject: subjectId,
        targetUserId: local?.userId ?? null,
        action: "revoke-sessions",
        requested: {},
        outcome: "applied",
        revocation,
    });
    return { revocation, correlationId };
}

/** The latest audit entries about a subject. */
export async function accessHistory(
    context: AdminContext,
    subjectId: string,
    limit = 20,
) {
    assertAccessAdministrator(context);
    return db
        .select({
            at: accessChangeLog.at,
            correlationId: accessChangeLog.correlationId,
            actorSubject: accessChangeLog.actorSubject,
            actorUserId: accessChangeLog.actorUserId,
            action: accessChangeLog.action,
            requested: accessChangeLog.requested,
            outcome: accessChangeLog.outcome,
            revocation: accessChangeLog.revocation,
        })
        .from(accessChangeLog)
        .where(eq(accessChangeLog.targetSubject, subjectId))
        .orderBy(desc(accessChangeLog.at))
        .limit(Math.min(Math.max(limit, 1), 100));
}
