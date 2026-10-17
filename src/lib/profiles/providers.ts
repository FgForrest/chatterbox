import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials, type userSettings } from "@/db/schema";
import { loadDefaultProviderState } from "@/lib/ai/default-provider";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";
import {
    type DefaultProviderCandidate,
    defaultProviderCandidates,
} from "@/lib/ai/provider-resolution-order";
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

export type ResolvedStepProviderSelection =
    | (ResolvedProviderBase & {
          kind: "credential";
          credential: CredentialRow;
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

function missingProvider(
    message: string,
    details?: Record<string, unknown>,
): AppError {
    return new AppError(
        ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
        message,
        400,
        details,
    );
}

function resolvedCredentialSelection(
    credential: CredentialRow,
    payerUserId: string,
    reserveCall: () => Promise<void>,
    organizationCredential = false,
): ResolvedStepProviderSelection {
    return {
        kind: "credential",
        credential,
        payerUserId,
        reserveCall,
        organizationCredential,
    };
}

async function managedProvider(
    actorUserId: string,
): Promise<ResolvedStepProviderSelection> {
    return {
        kind: "managed",
        credential: null,
        provider: RIFFADO_INCLUDED_PROVIDER_LABEL,
        payerUserId: actorUserId,
        reserveCall: noReservation,
        organizationCredential: false,
    };
}

function decryptResolvedProvider(
    selection: ResolvedStepProviderSelection,
): ResolvedStepProvider {
    if (selection.kind === "managed") return selection;
    return {
        ...selection,
        credential: {
            ...selection.credential,
            apiKey: decrypt(selection.credential.apiKey),
        },
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

type ProviderChoice =
    | { kind: "profile-pin"; scope: "personal" | "organization" }
    | { kind: "member-default"; role: ProcessingStep }
    | { kind: "organization-default"; role: ProcessingStep }
    | { kind: "automatic" }
    | { kind: "selected"; role: ProcessingStep };

function assertEnabled(
    credential: CredentialRow,
    choice: ProviderChoice,
): void {
    if (credential.disabledAt) {
        let message = `The provider ${credential.provider} is disabled. Enable it or choose another provider.`;
        if (choice.kind === "profile-pin") {
            message = `The profile pin for ${credential.provider} is disabled. Enable it or choose another provider in the profile.`;
            if (choice.scope === "organization") {
                message = `The profile pin for ${credential.provider} is disabled. Ask an administrator to enable it or update the profile.`;
            }
        } else if (choice.kind === "member-default") {
            message = `Your default for ${choice.role}, ${credential.provider}, is disabled. Enable it or choose another provider.`;
        } else if (choice.kind === "organization-default") {
            message = `The Organization default for ${choice.role}, ${credential.provider}, is disabled. Ask an administrator to enable it or choose another Organization default.`;
        }
        throw new AppError(ErrorCode.CONFLICT, message, 409);
    }
}

function candidateChoice(
    candidate: DefaultProviderCandidate,
    step: ProcessingStep,
): ProviderChoice {
    if (candidate.source === "organization-role") {
        return { kind: "organization-default", role: step };
    }
    if (candidate.source === "organization-summary") {
        return { kind: "organization-default", role: "summary" };
    }
    if (candidate.source === "member-summary") {
        return { kind: "member-default", role: "summary" };
    }
    if (candidate.source === "member-fallback") return { kind: "automatic" };
    return { kind: "member-default", role: step };
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
}): Promise<ResolvedStepProviderSelection> {
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
    assertEnabled(credential, { kind: "profile-pin", scope: "personal" });
    assertSupportsStep(credential, input.step);
    return resolvedCredentialSelection(
        credential,
        input.actorUserId,
        noReservation,
    );
}

async function resolvePinnedOrganization(input: {
    step: ProcessingStep;
    pin: ProviderPin;
    actorUserId: string;
    credential?: CredentialRow;
    choice?: ProviderChoice;
}): Promise<ResolvedStepProviderSelection> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Organization providers are not available on this instance",
            404,
        );
    }
    const credential =
        input.credential ??
        (await credentialByOwner(input.pin.credentialId, orgUserId));
    if (!credential) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "The pinned Organization provider no longer exists. Ask an administrator to update the profile.",
            404,
        );
    }
    assertEnabled(
        credential,
        input.choice ?? { kind: "profile-pin", scope: "organization" },
    );
    assertSupportsStep(credential, input.step);
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

    return resolvedCredentialSelection(
        credential,
        orgUserId,
        reserveCall,
        true,
    );
}

function assertSupportsStep(
    credential: CredentialRow,
    step: ProcessingStep,
): void {
    if (
        step === "transcription" &&
        isEnhancementOnlyProvider(credential.provider)
    ) {
        throw missingProvider(
            `${credential.provider} cannot transcribe. Choose another provider in Settings.`,
        );
    }
    if (
        step !== "transcription" &&
        isTranscriptionOnlyProvider(credential.provider)
    ) {
        throw missingProvider(
            `${credential.provider} cannot run ${step}. Choose a chat provider in Settings.`,
        );
    }
}

async function organizationDefaultOwner(
    actorUserId: string,
): Promise<string | null> {
    if (!isOrgScopeEnabled()) return null;
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return null;
    if (!isIdpAuthorization() || actorUserId === orgUserId) return orgUserId;
    const access = await holderAccess(actorUserId);
    return access.ok && access.capabilities.has("use") ? orgUserId : null;
}

async function resolvePointer(input: {
    step: ProcessingStep;
    pointer: string;
    actorUserId: string;
    choice: ProviderChoice;
}): Promise<ResolvedStepProviderSelection> {
    if (isRiffadoIncludedProviderId(input.pointer)) {
        if (input.step === "transcription" && !isMynahConfigured()) {
            throw new AppError(
                ErrorCode.NO_TRANSCRIPTION_PROVIDER,
                `${RIFFADO_INCLUDED_PROVIDER_LABEL} is no longer available on this instance. Choose another provider in Settings.`,
                400,
            );
        }
        if (input.step !== "transcription") {
            throw missingProvider(
                `${RIFFADO_INCLUDED_PROVIDER_LABEL} is no longer available for ${input.step}. Choose another provider in Settings.`,
            );
        }
        return managedProvider(input.actorUserId);
    }
    const personal = await credentialByOwner(input.pointer, input.actorUserId);
    if (personal) {
        assertEnabled(personal, input.choice);
        assertSupportsStep(personal, input.step);
        return resolvedCredentialSelection(
            personal,
            input.actorUserId,
            noReservation,
        );
    }
    const orgUserId = await getOrgUserId();
    const organization = orgUserId
        ? await credentialByOwner(input.pointer, orgUserId)
        : undefined;
    if (organization) {
        return resolvePinnedOrganization({
            step: input.step,
            pin: { scope: "organization", credentialId: input.pointer },
            actorUserId: input.actorUserId,
            choice: input.choice,
        });
    }
    if (input.choice.kind === "member-default") {
        const message = `Your default for ${input.choice.role} no longer exists. Choose another provider in Settings.`;
        throw input.step === "transcription"
            ? new AppError(ErrorCode.NO_TRANSCRIPTION_PROVIDER, message, 400)
            : missingProvider(message);
    }
    if (input.choice.kind === "organization-default") {
        const message = `The Organization default for ${input.choice.role} no longer exists. Ask an administrator to choose another Organization default.`;
        throw input.step === "transcription"
            ? new AppError(ErrorCode.NO_TRANSCRIPTION_PROVIDER, message, 400)
            : missingProvider(message);
    }
    const message = `The selected ${input.step} provider no longer exists. Choose another provider in Settings.`;
    throw input.step === "transcription"
        ? new AppError(ErrorCode.NO_TRANSCRIPTION_PROVIDER, message, 400)
        : missingProvider(message);
}

/** Validate that an actor may select a provider pointer for one role. */
export async function validateDefaultProviderSelection(input: {
    actorUserId: string;
    role: ProcessingStep;
    providerId: string;
}): Promise<void> {
    const personal = await credentialByOwner(
        input.providerId,
        input.actorUserId,
    );
    if (personal) {
        assertEnabled(personal, { kind: "selected", role: input.role });
        if (
            input.role === "transcription" &&
            isEnhancementOnlyProvider(personal.provider)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `${personal.provider} cannot transcribe. Choose another provider.`,
                400,
                { field: "providerId" },
            );
        }
        if (
            input.role !== "transcription" &&
            isTranscriptionOnlyProvider(personal.provider)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `${personal.provider} cannot run ${input.role}. Choose a chat provider.`,
                400,
                { field: "providerId" },
            );
        }
        return;
    }
    const orgUserId = await getOrgUserId();
    const organization = orgUserId
        ? await credentialByOwner(input.providerId, orgUserId)
        : undefined;
    if (!organization) {
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
    }
    await resolvePinnedOrganization({
        step: input.role,
        pin: { scope: "organization", credentialId: input.providerId },
        actorUserId: input.actorUserId,
        choice: { kind: "selected", role: input.role },
    });
}

async function resolveUnpinned(
    step: ProcessingStep,
    actorUserId: string,
): Promise<ResolvedStepProviderSelection> {
    const actorState = await loadDefaultProviderState(actorUserId);
    const orgUserId = await organizationDefaultOwner(actorUserId);
    const organizationState = orgUserId
        ? await loadDefaultProviderState(orgUserId)
        : null;
    const [candidate] = defaultProviderCandidates(
        step,
        actorState.pointers,
        organizationState?.pointers ?? null,
        actorState.credentials,
    );
    if (candidate) {
        const choice = candidateChoice(candidate, step);
        const personal = actorState.credentials.find(
            (credential) => credential.id === candidate.providerId,
        );
        if (personal) {
            assertEnabled(personal, choice);
            assertSupportsStep(personal, step);
            return {
                ...resolvedCredentialSelection(
                    personal,
                    actorUserId,
                    noReservation,
                ),
                actorSettings: actorState.settings,
            };
        }
        const organization = organizationState?.credentials.find(
            (credential) => credential.id === candidate.providerId,
        );
        if (organization) {
            const resolved = await resolvePinnedOrganization({
                step,
                pin: {
                    scope: "organization",
                    credentialId: candidate.providerId,
                },
                actorUserId,
                credential: organization,
                choice,
            });
            return { ...resolved, actorSettings: actorState.settings };
        }
        const resolved = await resolvePointer({
            step,
            pointer: candidate.providerId,
            actorUserId,
            choice,
        });
        return { ...resolved, actorSettings: actorState.settings };
    }
    if (step === "transcription" && isMynahConfigured()) {
        return {
            ...(await managedProvider(actorUserId)),
            actorSettings: actorState.settings,
        };
    }
    if (step === "transcription") {
        throw new AppError(
            ErrorCode.NO_TRANSCRIPTION_PROVIDER,
            "No transcription API configured",
            400,
            { providerSelection: "absent" },
        );
    }
    throw missingProvider(`No provider is configured for ${step}`, {
        providerSelection: "absent",
    });
}

/** Choose and authorize one processing provider without decrypting its key. */
export async function resolveStepProviderSelection(input: {
    step: ProcessingStep;
    pin: ProviderPin | null;
    actorUserId: string;
}): Promise<ResolvedStepProviderSelection> {
    if (input.pin?.scope === "personal") {
        return resolvePinnedPersonal({ ...input, pin: input.pin });
    }
    if (input.pin?.scope === "organization") {
        return resolvePinnedOrganization({ ...input, pin: input.pin });
    }
    return resolveUnpinned(input.step, input.actorUserId);
}

/** Resolve one processing step's provider and decrypt its key for a request. */
export async function resolveStepProvider(input: {
    step: ProcessingStep;
    pin: ProviderPin | null;
    actorUserId: string;
}): Promise<ResolvedStepProvider> {
    return decryptResolvedProvider(await resolveStepProviderSelection(input));
}
