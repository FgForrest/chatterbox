import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials, userSettings } from "@/db/schema";
import {
    pickEnhancementCredential,
    pickLearnCredential,
    pickTopicsCredential,
} from "@/lib/ai/enhancement-provider";
import { titleProviderId } from "@/lib/ai/title-provider";
import { holderAccess } from "@/lib/authz/access-state";
import { decrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { isMynahConfigured } from "@/lib/hosted/transcription/mynah";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import {
    isRiffadoIncludedProviderId,
    RIFFADO_INCLUDED_PROVIDER_LABEL,
} from "@/lib/transcription/included-provider";
import type { ProfileScope, ProfileSettings, ProviderPin } from "./settings";

export type ProcessingStep =
    | "transcription"
    | "summary"
    | "learn"
    | "topics"
    | "title";

type CredentialRow = typeof apiCredentials.$inferSelect;
export type DecryptedCredential = Omit<CredentialRow, "apiKey"> & {
    apiKey: string;
};

interface ResolvedProviderBase {
    payerUserId: string;
    reserveCall: () => Promise<void>;
    organizationCredential: boolean;
    actorSettings?: typeof userSettings.$inferSelect;
}

export type ResolvedStepProvider =
    | (ResolvedProviderBase & {
          kind: "credential";
          credential: DecryptedCredential;
      })
    | (ResolvedProviderBase & {
          kind: "managed";
          credential: null;
          provider: typeof RIFFADO_INCLUDED_PROVIDER_LABEL;
      });

const ONE_HOUR_MS = 60 * 60 * 1000;

function noReservation(): Promise<void> {
    return Promise.resolve();
}

function missingProvider(message: string): AppError {
    return new AppError(ErrorCode.AI_PROVIDER_NOT_CONFIGURED, message, 400);
}

function resolvedCredential(
    credential: CredentialRow,
    payerUserId: string,
    reserveCall: () => Promise<void>,
    organizationCredential = false,
): ResolvedStepProvider {
    return {
        kind: "credential",
        credential: { ...credential, apiKey: decrypt(credential.apiKey) },
        payerUserId,
        reserveCall,
        organizationCredential,
    };
}

async function managedProvider(
    actorUserId: string,
): Promise<ResolvedStepProvider> {
    return {
        kind: "managed",
        credential: null,
        provider: RIFFADO_INCLUDED_PROVIDER_LABEL,
        payerUserId: actorUserId,
        reserveCall: noReservation,
        organizationCredential: false,
    };
}

async function credentialByOwner(
    credentialId: string,
    ownerUserId: string,
): Promise<CredentialRow | undefined> {
    const [credential] = await db
        .select()
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.id, credentialId),
                eq(apiCredentials.userId, ownerUserId),
            ),
        )
        .limit(1);
    return credential;
}

function assertEnabled(
    credential: CredentialRow,
    scope: "personal" | "organization",
): void {
    if (credential.disabledAt) {
        const message =
            scope === "organization"
                ? `The pinned provider ${credential.provider} is disabled. Ask an administrator to enable it or choose another provider.`
                : `The provider ${credential.provider} is disabled. Enable it or choose another provider.`;
        throw new AppError(ErrorCode.CONFLICT, message, 409);
    }
}

interface SubmittedPin {
    path: string[];
    step: string;
    pin: ProviderPin;
}

function submittedPins(settings: ProfileSettings): SubmittedPin[] {
    const pins: SubmittedPin[] = [];
    for (const [stepName, value] of Object.entries(settings.steps)) {
        if (!("provider" in value) || value.provider === null) continue;
        pins.push({
            path: ["settings", "steps", stepName, "provider"],
            step: stepName,
            pin: value.provider,
        });
    }
    return pins;
}

function invalidPin(message: string, path: string[]): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, {
        field: path.join("."),
        path,
    });
}

/** Validate every provider pin before profile settings are saved. */
export async function validateProfileProviderPins(input: {
    actorUserId: string;
    profileOwnerUserId: string;
    profileScope: ProfileScope;
    settings: ProfileSettings;
}): Promise<void> {
    for (const { path, pin, step } of submittedPins(input.settings)) {
        if (pin.scope === "personal") {
            if (input.profileScope !== "personal") {
                throw invalidPin(
                    "Organization profiles may only pin Organization providers",
                    path,
                );
            }
            if (input.profileOwnerUserId !== input.actorUserId) {
                throw invalidPin(
                    "A personal profile may only pin its owner's providers",
                    path,
                );
            }
            if (isRiffadoIncludedProviderId(pin.credentialId)) {
                if (step !== "transcribe") {
                    throw invalidPin(
                        `${RIFFADO_INCLUDED_PROVIDER_LABEL} can only be pinned for transcription`,
                        path,
                    );
                }
                if (!isMynahConfigured()) {
                    throw invalidPin(
                        `${RIFFADO_INCLUDED_PROVIDER_LABEL} is not available on this instance`,
                        path,
                    );
                }
                continue;
            }
            const credential = await credentialByOwner(
                pin.credentialId,
                input.actorUserId,
            );
            if (!credential) {
                throw invalidPin(
                    "The pinned personal provider does not belong to you",
                    path,
                );
            }
            continue;
        }

        const orgUserId = await getOrgUserId();
        if (!orgUserId) {
            throw invalidPin(
                "Organization providers are not available on this instance",
                path,
            );
        }
        const credential = await credentialByOwner(pin.credentialId, orgUserId);
        if (!credential) {
            throw invalidPin(
                "The pinned Organization provider does not exist",
                path,
            );
        }
    }
}

async function resolvePinnedPersonal(input: {
    step: ProcessingStep;
    pin: ProviderPin;
    actorUserId: string;
}): Promise<ResolvedStepProvider> {
    if (isRiffadoIncludedProviderId(input.pin.credentialId)) {
        if (input.step !== "transcription") {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `${RIFFADO_INCLUDED_PROVIDER_LABEL} can only be pinned for transcription`,
                400,
            );
        }
        if (!isMynahConfigured()) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                `${RIFFADO_INCLUDED_PROVIDER_LABEL} is no longer available on this instance. Choose another provider in the profile.`,
                404,
            );
        }
        return managedProvider(input.actorUserId);
    }

    const credential = await credentialByOwner(
        input.pin.credentialId,
        input.actorUserId,
    );
    if (!credential) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "The pinned personal provider no longer exists or does not belong to you. Choose another provider in the profile.",
            404,
        );
    }
    assertEnabled(credential, "personal");
    return resolvedCredential(credential, input.actorUserId, noReservation);
}

async function resolvePinnedOrganization(input: {
    step: ProcessingStep;
    pin: ProviderPin;
    actorUserId: string;
}): Promise<ResolvedStepProvider> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Organization providers are not available on this instance",
            404,
        );
    }
    const credential = await credentialByOwner(
        input.pin.credentialId,
        orgUserId,
    );
    if (!credential) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "The pinned Organization provider no longer exists. Ask an administrator to update the profile.",
            404,
        );
    }
    assertEnabled(credential, "organization");
    if (!isOrgScopeEnabled()) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Organization providers are unavailable while the Organization scope is disabled",
            404,
        );
    }
    if (isIdpAuthorization()) {
        const access = await holderAccess(input.actorUserId);
        if (!access.ok || !access.capabilities.has("use")) {
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Your current Organization access does not permit using this provider",
                403,
            );
        }
    }

    const reserveCall = async (): Promise<void> => {
        const result = await consumeRateLimitBucket(
            `org-provider:${credential.id}:${input.actorUserId}`,
            {
                limit: env.ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR,
                windowMs: ONE_HOUR_MS,
            },
        );
        if (!result.allowed) {
            throw new AppError(
                ErrorCode.AI_RATE_LIMITED,
                "Your Organization provider call limit has been reached. Try again after the hourly limit resets.",
                429,
                { resetAt: result.resetAt.toISOString() },
            );
        }
    };

    return resolvedCredential(credential, orgUserId, reserveCall, true);
}

async function actorCredentials(
    actorUserId: string,
    ordered: boolean,
): Promise<CredentialRow[]> {
    const query = db
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, actorUserId));
    return ordered
        ? query.orderBy(apiCredentials.createdAt, apiCredentials.id)
        : query;
}

async function actorProviderSettings(actorUserId: string) {
    const [settings] = await db
        .select({
            transcription: userSettings.defaultTranscriptionProviderId,
            defaults: userSettings.defaultProviders,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, actorUserId))
        .limit(1);
    return settings;
}

async function resolveUnpinnedTranscription(
    actorUserId: string,
): Promise<ResolvedStepProvider> {
    const [legacyDefault] = await db
        .select()
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.userId, actorUserId),
                eq(apiCredentials.isDefaultTranscription, true),
            ),
        )
        .limit(1);
    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, actorUserId))
        .limit(1);
    const pointer = settings?.defaultTranscriptionProviderId ?? null;
    if (isRiffadoIncludedProviderId(pointer)) {
        if (!isMynahConfigured()) {
            throw new AppError(
                ErrorCode.NO_TRANSCRIPTION_PROVIDER,
                `${RIFFADO_INCLUDED_PROVIDER_LABEL} is no longer available on this instance. Choose another provider in Settings.`,
                400,
            );
        }
        return {
            ...(await managedProvider(actorUserId)),
            actorSettings: settings,
        };
    }
    if (pointer) {
        const credential = await credentialByOwner(pointer, actorUserId);
        if (!credential) {
            throw new AppError(
                ErrorCode.NO_TRANSCRIPTION_PROVIDER,
                "The selected transcription provider no longer exists. Choose another provider in Settings.",
                400,
            );
        }
        assertEnabled(credential, "personal");
        return {
            ...resolvedCredential(credential, actorUserId, noReservation),
            actorSettings: settings,
        };
    }
    if (legacyDefault) {
        assertEnabled(legacyDefault, "personal");
        return {
            ...resolvedCredential(legacyDefault, actorUserId, noReservation),
            actorSettings: settings,
        };
    }
    if (isMynahConfigured()) {
        return {
            ...(await managedProvider(actorUserId)),
            actorSettings: settings,
        };
    }
    throw new AppError(
        ErrorCode.NO_TRANSCRIPTION_PROVIDER,
        "No transcription API configured",
        400,
    );
}

async function resolveUnpinnedChat(
    step: Exclude<ProcessingStep, "transcription">,
    actorUserId: string,
): Promise<ResolvedStepProvider> {
    const ordered = step === "title";
    const credentials = await actorCredentials(actorUserId, ordered);
    let picked: CredentialRow | undefined;
    if (step === "summary") {
        const selected = credentials.find(
            (candidate) => candidate.isDefaultEnhancement,
        );
        if (selected) assertEnabled(selected, "personal");
        picked = pickEnhancementCredential(credentials);
    } else if (step === "learn") {
        const selected = credentials.find(
            (candidate) => candidate.isDefaultLearn,
        );
        if (selected) assertEnabled(selected, "personal");
        picked = pickLearnCredential(credentials);
    } else {
        const settings = await actorProviderSettings(actorUserId);
        if (step === "topics") {
            const defaults = settings?.defaults;
            const topicsId =
                defaults &&
                typeof defaults === "object" &&
                !Array.isArray(defaults)
                    ? (defaults as Record<string, unknown>).topics
                    : null;
            const selectedId = typeof topicsId === "string" ? topicsId : null;
            const selected = credentials.find(
                (candidate) => candidate.id === selectedId,
            );
            if (selected) assertEnabled(selected, "personal");
            picked = pickTopicsCredential(credentials, selectedId);
        } else {
            const selectedId = titleProviderId(settings?.defaults);
            const selected = credentials.find(
                (candidate) => candidate.id === selectedId,
            );
            if (selected) assertEnabled(selected, "personal");
            picked = selected ?? pickEnhancementCredential(credentials);
        }
    }

    if (!picked) {
        const configured = credentials.some(
            (credential) => credential.disabledAt === null,
        );
        let message = "No AI provider configured";
        if (configured && step === "summary") {
            message =
                "Your AI providers are transcription only. Add an OpenAI-compatible provider to generate summaries.";
        } else if (configured && step === "topics") {
            message =
                "Your AI providers are transcription only. Add an OpenAI-compatible provider to detect topics.";
        }
        throw missingProvider(message);
    }
    return resolvedCredential(picked, actorUserId, noReservation);
}

/** Resolve one processing step's provider and payer at the moment it runs. */
export async function resolveStepProvider(input: {
    step: ProcessingStep;
    pin: ProviderPin | null;
    actorUserId: string;
}): Promise<ResolvedStepProvider> {
    if (input.pin?.scope === "personal") {
        return resolvePinnedPersonal({ ...input, pin: input.pin });
    }
    if (input.pin?.scope === "organization") {
        return resolvePinnedOrganization({ ...input, pin: input.pin });
    }
    return input.step === "transcription"
        ? resolveUnpinnedTranscription(input.actorUserId)
        : resolveUnpinnedChat(input.step, input.actorUserId);
}
