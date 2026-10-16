import { and, count, eq, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import {
    adminActionLog,
    aiUsageEvents,
    apiCredentials,
    users,
} from "@/db/schema";
import { hasRate, storedRate } from "@/lib/ai/published-rates";
import type { ActorContext } from "@/lib/authz/model";
import { mayManageAccess, mayUse } from "@/lib/authz/policy";
import { AppError, ErrorCode } from "@/lib/errors";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";

export interface OrganizationProviderActor {
    actor: ActorContext;
    userId: string;
    email: string;
}

export interface OrganizationProviderContext extends OrganizationProviderActor {
    orgUserId: string;
}

export interface OrganizationProviderInput {
    provider: string;
    encryptedApiKey: string;
    baseUrl: string | null;
    defaultModel: string | null;
    rates: {
        inputUsdPerMillion: string | null;
        outputUsdPerMillion: string | null;
        audioUsdPerHour: string | null;
    };
}

export interface OrganizationProviderUpdate {
    encryptedApiKey?: string;
    baseUrl?: string | null;
    defaultModel?: string | null;
    rates?: OrganizationProviderInput["rates"];
    disabled?: boolean;
}

type CredentialRow = typeof apiCredentials.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type OrganizationProviderAuditContext = Pick<
    OrganizationProviderContext,
    "userId" | "email" | "orgUserId"
>;

/** Identify a local organization account using the personal provider routes. */
export async function organizationAccountProviderAuditContext(input: {
    userId: string;
    email: string;
}): Promise<OrganizationProviderAuditContext | null> {
    if (isIdpAuthorization()) return null;
    const orgUserId = await getOrgUserId();
    return orgUserId === input.userId ? { ...input, orgUserId } : null;
}

function unavailable(): AppError {
    return new AppError(
        ErrorCode.NOT_FOUND,
        "Organization providers are not available on this instance",
        404,
    );
}

/** Authorize a member to see Organization provider cards. */
export async function organizationProviderReadContext(
    input: OrganizationProviderActor,
): Promise<OrganizationProviderContext> {
    if (!isOrgScopeEnabled()) throw unavailable();
    const orgUserId = await getOrgUserId();
    if (!orgUserId) throw unavailable();
    if (!mayUse(input.actor)) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Organization access is required to view these providers",
            403,
        );
    }
    return { ...input, orgUserId };
}

/** Authorize Organization provider management. */
export async function organizationProviderManageContext(
    input: OrganizationProviderActor,
): Promise<OrganizationProviderContext> {
    const context = await organizationProviderReadContext(input);
    const allowed = isIdpAuthorization()
        ? input.actor.kind === "user" && mayManageAccess(input.actor)
        : input.actor.actorId === context.orgUserId;
    if (!allowed) {
        throw new AppError(
            ErrorCode.CAPABILITY_REQUIRED,
            isIdpAuthorization()
                ? "Organization provider management requires access.manage"
                : "Only the organization account may manage Organization providers",
            403,
        );
    }
    return context;
}

function publicProvider(row: CredentialRow) {
    const rate = storedRate(row);
    return {
        id: row.id,
        provider: row.provider,
        baseUrl: row.baseUrl,
        defaultModel: row.defaultModel,
        rate: hasRate(rate) ? rate : null,
        disabledAt: row.disabledAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        scope: "organization" as const,
    };
}

function auditSnapshot(row: CredentialRow | null) {
    if (!row) return null;
    return {
        provider: row.provider,
        baseUrl: row.baseUrl,
        model: row.defaultModel,
        label: row.provider,
        disabled: row.disabledAt !== null,
    };
}

/** Write the non-secret audit record for an Organization provider mutation. */
export async function writeOrganizationProviderAudit(
    tx: Tx,
    input: {
        context: OrganizationProviderAuditContext;
        action: string;
        credentialId: string;
        before: CredentialRow | null;
        after: CredentialRow | null;
    },
): Promise<void> {
    await tx.insert(adminActionLog).values({
        adminUserId: input.context.userId,
        adminUserEmail: input.context.email,
        action: input.action,
        targetUserId: input.context.orgUserId,
        targetResourceId: input.credentialId,
        reason: "Organization provider settings change",
        before: auditSnapshot(input.before),
        after: auditSnapshot(input.after),
    });
}

/** List Organization-owned provider cards without their keys. */
export async function listOrganizationProviders(
    context: OrganizationProviderContext,
) {
    const rows = await db
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, context.orgUserId))
        .orderBy(apiCredentials.createdAt, apiCredentials.id);
    return rows.map(publicProvider);
}

/** Create one Organization-owned provider and its audit row atomically. */
export async function createOrganizationProvider(
    context: OrganizationProviderContext,
    input: OrganizationProviderInput,
) {
    return db.transaction(async (tx) => {
        const [created] = await tx
            .insert(apiCredentials)
            .values({
                userId: context.orgUserId,
                provider: input.provider,
                apiKey: input.encryptedApiKey,
                baseUrl: input.baseUrl,
                defaultModel: input.defaultModel,
                ...input.rates,
            })
            .returning();
        if (!created) {
            throw new AppError(
                ErrorCode.INTERNAL_ERROR,
                "Organization provider was not created",
                500,
            );
        }
        await writeOrganizationProviderAudit(tx, {
            context,
            action: "org_provider.create",
            credentialId: created.id,
            before: null,
            after: created,
        });
        return publicProvider(created);
    });
}

/** Update, disable, or enable one Organization provider with an audit row. */
export async function updateOrganizationProvider(
    context: OrganizationProviderContext,
    credentialId: string,
    input: OrganizationProviderUpdate,
) {
    return db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, context.orgUserId),
                    eq(apiCredentials.id, credentialId),
                ),
            )
            .for("update")
            .limit(1);
        if (!before || before.id !== credentialId) {
            throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
        }
        const update: Partial<typeof apiCredentials.$inferInsert> = {
            updatedAt: new Date(),
        };
        if (input.encryptedApiKey !== undefined) {
            update.apiKey = input.encryptedApiKey;
        }
        if (input.baseUrl !== undefined) update.baseUrl = input.baseUrl;
        if (input.defaultModel !== undefined) {
            update.defaultModel = input.defaultModel;
        }
        if (input.rates) Object.assign(update, input.rates);
        if (input.disabled !== undefined) {
            update.disabledAt = input.disabled ? new Date() : null;
        }
        const [after] = await tx
            .update(apiCredentials)
            .set(update)
            .where(
                and(
                    eq(apiCredentials.userId, context.orgUserId),
                    eq(apiCredentials.id, credentialId),
                ),
            )
            .returning();
        if (!after) {
            throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
        }
        const action =
            before.disabledAt === null && after.disabledAt !== null
                ? "org_provider.disable"
                : before.disabledAt !== null && after.disabledAt === null
                  ? "org_provider.enable"
                  : "org_provider.update";
        await writeOrganizationProviderAudit(tx, {
            context,
            action,
            credentialId,
            before,
            after,
        });
        return publicProvider(after);
    });
}

/** Delete one Organization provider and retain its non-secret audit snapshot. */
export async function deleteOrganizationProvider(
    context: OrganizationProviderContext,
    credentialId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        const [before] = await tx
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, context.orgUserId),
                    eq(apiCredentials.id, credentialId),
                ),
            )
            .for("update")
            .limit(1);
        if (!before || before.id !== credentialId) {
            throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
        }
        await tx
            .delete(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, context.orgUserId),
                    eq(apiCredentials.id, credentialId),
                ),
            );
        await writeOrganizationProviderAudit(tx, {
            context,
            action: "org_provider.delete",
            credentialId,
            before,
            after: null,
        });
    });
}

export interface OrganizationProviderMemberUsage {
    userId: string;
    email: string;
    calls: number;
    estimatedCostUsd: string;
}

/** Aggregate Organization-paid calls and known estimated cost by member. */
export async function organizationProviderUsage(
    context: OrganizationProviderContext,
): Promise<OrganizationProviderMemberUsage[]> {
    const actorUserId = sql<string>`coalesce(${aiUsageEvents.actorUserId}, ${aiUsageEvents.userId})`;
    const rows = await db
        .select({
            userId: actorUserId,
            email: users.email,
            calls: count(aiUsageEvents.id),
            estimatedCostUsd: sum(aiUsageEvents.costUsd),
        })
        .from(aiUsageEvents)
        .innerJoin(users, eq(users.id, actorUserId))
        .where(eq(aiUsageEvents.payerUserId, context.orgUserId))
        .groupBy(actorUserId, users.email)
        .orderBy(users.email, actorUserId);
    return rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        calls: Number(row.calls),
        estimatedCostUsd: row.estimatedCostUsd ?? "0.000000000",
    }));
}
