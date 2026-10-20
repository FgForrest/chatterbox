import { and, count, eq, ne, or, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import {
    adminActionLog,
    aiUsageEvents,
    apiCredentials,
    userSettings,
    users,
} from "@/db/schema";
import {
    type DefaultProviderPointers,
    loadDefaultProviderPointers,
    type ProviderRole,
    setDefaultProvider,
} from "@/lib/ai/default-provider";
import { enhancementModelRequiredMessage } from "@/lib/ai/enhancement-provider";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";
import { hasRate, storedRate } from "@/lib/ai/published-rates";
import type { ActorContext } from "@/lib/authz/model";
import { mayManageAccess, mayUse } from "@/lib/authz/policy";
import { AppError, ErrorCode } from "@/lib/errors";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { nudge } from "@/lib/jobs/nudge";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { requestProviderRecoveryInTx } from "@/lib/pipeline/provider-recovery";

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
    encryptedApiKey?: string;
    copyKeyFrom?: string;
    baseUrl: string | null;
    defaultModel: string | null;
    maxOutputTokens?: number | null;
    rates: {
        inputUsdPerMillion: string | null;
        outputUsdPerMillion: string | null;
        audioUsdPerHour: string | null;
    };
    defaults?: Partial<Record<ProviderRole, boolean>>;
}

export interface OrganizationProviderUpdate {
    encryptedApiKey?: string;
    baseUrl?: string | null;
    defaultModel?: string | null;
    maxOutputTokens?: number | null;
    rates?: OrganizationProviderInput["rates"];
    disabled?: boolean;
    defaults?: Partial<Record<ProviderRole, boolean>>;
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

function publicProvider(
    row: CredentialRow,
    pointers?: DefaultProviderPointers,
) {
    const rate = storedRate(row);
    return {
        id: row.id,
        provider: row.provider,
        baseUrl: row.baseUrl,
        defaultModel: row.defaultModel,
        maxOutputTokens: row.maxOutputTokens,
        rate: hasRate(rate) ? rate : null,
        disabledAt: row.disabledAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        scope: "organization" as const,
        isDefaultTranscription: pointers?.transcription === row.id,
        isDefaultEnhancement: pointers?.summary === row.id,
        isDefaultLearn: pointers?.learn === row.id,
        isDefaultTopics: pointers?.topics === row.id,
        isDefaultTitle: pointers?.title === row.id,
    };
}

async function applyOrganizationDefaults(
    tx: Tx,
    orgUserId: string,
    credential: Pick<CredentialRow, "id" | "provider">,
    defaults: Partial<Record<ProviderRole, boolean>> | undefined,
): Promise<{
    before: DefaultProviderPointers;
    after: DefaultProviderPointers;
}> {
    const current = await loadDefaultProviderPointers(orgUserId, tx);
    if (!defaults) return { before: current, after: current };
    const roles: ProviderRole[] = [
        "transcription",
        "summary",
        "learn",
        "topics",
        "title",
    ];
    for (const role of roles) {
        const selected = defaults[role];
        if (selected === true) {
            await setDefaultProvider(orgUserId, role, credential.id, {
                transaction: tx,
            });
        } else if (selected === false && current[role] === credential.id) {
            await setDefaultProvider(orgUserId, role, null, {
                transaction: tx,
                onlyIf: credential.id,
            });
        }
    }
    return {
        before: current,
        after: await loadDefaultProviderPointers(orgUserId, tx),
    };
}

function validateOrganizationDefaults(
    provider: string,
    defaults: Partial<Record<ProviderRole, boolean>> | undefined,
    disabled: boolean,
): void {
    if (disabled && Object.values(defaults ?? {}).some(Boolean)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A disabled provider cannot be an Organization default",
            400,
        );
    }
    if (defaults?.transcription && isEnhancementOnlyProvider(provider)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider} cannot transcribe`,
            400,
        );
    }
    const chatRoles: ProviderRole[] = ["summary", "learn", "topics", "title"];
    if (
        isTranscriptionOnlyProvider(provider) &&
        chatRoles.some((role) => defaults?.[role] === true)
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider} cannot be an Organization chat default`,
            400,
        );
    }
}

function auditSnapshot(
    row: CredentialRow | null,
    pointers?: DefaultProviderPointers,
) {
    if (!row) return null;
    return {
        provider: row.provider,
        baseUrl: row.baseUrl,
        model: row.defaultModel,
        maxOutputTokens: row.maxOutputTokens,
        label: row.provider,
        disabled: row.disabledAt !== null,
        defaults: pointers
            ? (Object.entries(pointers) as [ProviderRole, string | null][])
                  .filter(([, providerId]) => providerId === row.id)
                  .map(([role]) => role)
            : [],
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
        beforeDefaults?: DefaultProviderPointers;
        afterDefaults?: DefaultProviderPointers;
    },
): Promise<void> {
    await tx.insert(adminActionLog).values({
        adminUserId: input.context.userId,
        adminUserEmail: input.context.email,
        action: input.action,
        targetUserId: input.context.orgUserId,
        targetResourceId: input.credentialId,
        reason: "Organization provider settings change",
        before: auditSnapshot(input.before, input.beforeDefaults),
        after: auditSnapshot(input.after, input.afterDefaults),
    });
}

/** List Organization-owned provider cards without their keys. */
export async function listOrganizationProviders(
    context: OrganizationProviderContext,
) {
    const [rows, pointers] = await Promise.all([
        db
            .select()
            .from(apiCredentials)
            .where(eq(apiCredentials.userId, context.orgUserId))
            .orderBy(apiCredentials.createdAt, apiCredentials.id),
        loadDefaultProviderPointers(context.orgUserId),
    ]);
    return rows.map((row) => publicProvider(row, pointers));
}

/** Create one Organization-owned provider and its audit row atomically. */
export async function createOrganizationProvider(
    context: OrganizationProviderContext,
    input: OrganizationProviderInput,
) {
    if (
        !isTranscriptionOnlyProvider(input.provider) &&
        !input.defaultModel?.trim()
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            enhancementModelRequiredMessage(input.provider),
            400,
            { field: "defaultModel" },
        );
    }
    validateOrganizationDefaults(input.provider, input.defaults, false);
    const provider = await db.transaction(async (tx) => {
        let encryptedApiKey = input.encryptedApiKey;
        if (!encryptedApiKey && input.copyKeyFrom) {
            const [source] = await tx
                .select({
                    provider: apiCredentials.provider,
                    apiKey: apiCredentials.apiKey,
                })
                .from(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.userId, context.orgUserId),
                        eq(apiCredentials.id, input.copyKeyFrom),
                    ),
                )
                .limit(1);
            if (!source) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "The provider to duplicate no longer exists",
                    404,
                );
            }
            if (source.provider !== input.provider) {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    `A duplicate keeps its provider: ${source.provider}'s key cannot be used for ${input.provider}.`,
                    400,
                    { field: "provider" },
                );
            }
            encryptedApiKey = source.apiKey;
        }
        if (!encryptedApiKey) {
            throw new AppError(
                ErrorCode.MISSING_REQUIRED_FIELD,
                "Provider and API key are required",
                400,
            );
        }
        const [created] = await tx
            .insert(apiCredentials)
            .values({
                userId: context.orgUserId,
                provider: input.provider,
                apiKey: encryptedApiKey,
                baseUrl: input.baseUrl,
                defaultModel: input.defaultModel,
                maxOutputTokens: input.maxOutputTokens ?? null,
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
        const defaults = await applyOrganizationDefaults(
            tx,
            context.orgUserId,
            created,
            input.defaults,
        );
        await writeOrganizationProviderAudit(tx, {
            context,
            action: "org_provider.create",
            credentialId: created.id,
            before: null,
            after: created,
            beforeDefaults: defaults.before,
            afterDefaults: defaults.after,
        });
        await requestProviderRecoveryInTx(tx, context.orgUserId);
        return publicProvider(created, defaults.after);
    });
    nudge();
    return provider;
}

/** Update, disable, or enable one Organization provider with an audit row. */
export async function updateOrganizationProvider(
    context: OrganizationProviderContext,
    credentialId: string,
    input: OrganizationProviderUpdate,
) {
    const provider = await db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, context.orgUserId))
            .for("update");
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
        const effectiveDefaultModel =
            input.defaultModel === undefined
                ? before.defaultModel
                : input.defaultModel;
        const effectiveDisabled = input.disabled ?? before.disabledAt !== null;
        if (
            !effectiveDisabled &&
            !isTranscriptionOnlyProvider(before.provider) &&
            !effectiveDefaultModel?.trim()
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                enhancementModelRequiredMessage(before.provider),
                400,
                { field: "defaultModel" },
            );
        }
        validateOrganizationDefaults(
            before.provider,
            input.defaults,
            effectiveDisabled,
        );
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
        if (input.maxOutputTokens !== undefined) {
            update.maxOutputTokens = input.maxOutputTokens;
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
        let action = "org_provider.update";
        if (before.disabledAt === null && after.disabledAt !== null) {
            action = "org_provider.disable";
        } else if (before.disabledAt !== null && after.disabledAt === null) {
            action = "org_provider.enable";
        }
        const defaults = await applyOrganizationDefaults(
            tx,
            context.orgUserId,
            after,
            input.defaults,
        );
        await writeOrganizationProviderAudit(tx, {
            context,
            action,
            credentialId,
            before,
            after,
            beforeDefaults: defaults.before,
            afterDefaults: defaults.after,
        });
        if (before.disabledAt !== null && after.disabledAt === null) {
            await requestProviderRecoveryInTx(tx, context.orgUserId);
        }
        return publicProvider(after, defaults.after);
    });
    nudge();
    return provider;
}

/** Delete one Organization provider and retain its non-secret audit snapshot. */
export async function deleteOrganizationProvider(
    context: OrganizationProviderContext,
    credentialId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, context.orgUserId))
            .for("update");
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
        const beforeDefaults = await loadDefaultProviderPointers(
            context.orgUserId,
            tx,
        );
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
            beforeDefaults,
            afterDefaults: await loadDefaultProviderPointers(
                context.orgUserId,
                tx,
            ),
        });
    });
}

/** Count member-owned default pointers that refer to one Organization provider. */
export async function organizationProviderMemberDefaultCount(
    context: OrganizationProviderContext,
    credentialId: string,
): Promise<number> {
    const [credential] = await db
        .select({ id: apiCredentials.id })
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.userId, context.orgUserId),
                eq(apiCredentials.id, credentialId),
            ),
        )
        .limit(1);
    if (!credential) {
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
    }
    const [result] = await db
        .select({ count: count(userSettings.userId) })
        .from(userSettings)
        .where(
            and(
                ne(userSettings.userId, context.orgUserId),
                or(
                    eq(
                        userSettings.defaultTranscriptionProviderId,
                        credentialId,
                    ),
                    sql`${userSettings.defaultProviders} ->> 'summary' = ${credentialId}`,
                    sql`${userSettings.defaultProviders} ->> 'learn' = ${credentialId}`,
                    sql`${userSettings.defaultProviders} ->> 'topics' = ${credentialId}`,
                    sql`${userSettings.defaultProviders} ->> 'title' = ${credentialId}`,
                ),
            ),
        );
    return Number(result?.count ?? 0);
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
