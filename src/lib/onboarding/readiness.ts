import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { type HolderAccess, holderAccess } from "@/lib/authz/access-state";
import { AppError } from "@/lib/errors";
import { isIdpAuthorization } from "@/lib/identity/factory";
import {
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
    getGoogleOAuthConfig,
} from "@/lib/integrations/google/config";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import { GOOGLE_MEET_READ_SCOPE } from "@/lib/integrations/google/meet-consent";
import { isMailEnabled } from "@/lib/mail/config";
import { loadMailSettings } from "@/lib/mail/views";
import { isMcpEnabled } from "@/lib/mcp/config";
import { mcpResourceUrl } from "@/lib/mcp/metadata";
import type {
    OnboardingCapabilities,
    OnboardingReadiness,
    OnboardingStatus,
    ProfileReadiness,
    ProviderReadiness,
} from "@/lib/onboarding/capabilities";
import {
    getOrgUserId,
    isOrgAccount,
    isOrgScopeEnabled,
} from "@/lib/org/config";
import { resolveStepProviderSelection } from "@/lib/profiles/providers";
import type { ProfileChannel, ProviderPin } from "@/lib/profiles/settings";
import { getDefaultProfileState } from "@/lib/profiles/store";
import { RECORDER_EXTENSION_STORE_URL } from "@/lib/recorder-extension/extension-id";
import { getManagedTranscriptionProvider } from "@/lib/transcription/included-provider";

/** Read deployment and audience capabilities for an authenticated actor. */
export async function loadOnboardingCapabilities(
    userId: string,
    organization?: { id: string | null; isAccount: boolean },
): Promise<OnboardingCapabilities> {
    const [organizationId, organizationAccount] = organization
        ? [organization.id, organization.isAccount]
        : await Promise.all([getOrgUserId(), isOrgAccount(userId)]);
    return {
        audience: organizationAccount
            ? "organization-account"
            : organizationId
              ? "organization-member"
              : "single-user",
        googleConfigured: getGoogleOAuthConfig() !== null,
        mailAvailable: isMailEnabled() && !organizationAccount,
        mcpConnectorUrl: isMcpEnabled() ? mcpResourceUrl() : null,
        recorderStoreUrl: RECORDER_EXTENSION_STORE_URL,
    };
}

async function providerReadiness(
    userId: string,
    step: "transcription" | "summary",
    pin: ProviderPin | null,
    organizationDefaultsOnly: boolean,
    readOnlyAccess: () => Promise<HolderAccess>,
): Promise<ProviderReadiness> {
    try {
        const selected = await resolveStepProviderSelection({
            actorUserId: userId,
            step,
            pin,
            readOnly: true,
            readOnlyAccess,
            organizationDefaultsOnly,
        });
        if (selected.kind === "managed") {
            const managed = await getManagedTranscriptionProvider(
                userId,
                false,
            );
            return {
                source: "managed",
                name: selected.provider,
                status: managed?.available === true ? "ready" : "not-connected",
            };
        }
        return {
            source:
                selected.organizationCredential ||
                selected.credential.userId === (await getOrgUserId())
                    ? "organization"
                    : "own",
            name: selected.credential.provider,
            status: "ready",
        };
    } catch (error) {
        return {
            source: "none",
            name: null,
            status:
                error instanceof AppError && error.statusCode < 500
                    ? "not-connected"
                    : "error",
        };
    }
}

async function channelReadiness(
    userId: string,
    channel: ProfileChannel,
    organizationDefaultsOnly: boolean,
    accessCheck: Promise<void>,
    readOnlyAccess: () => Promise<HolderAccess>,
) {
    try {
        await accessCheck;
        const state = await getDefaultProfileState(userId, channel, userId, {
            seed: false,
            readOnlyAccess,
        });
        const profile = state.effective;
        const profileReadiness: ProfileReadiness = {
            status: state.explicitUnavailable
                ? "error"
                : profile
                  ? "ready"
                  : "not-connected",
            name: profile?.name ?? null,
        };
        const unavailable: ProviderReadiness = {
            source: "none",
            name: null,
            status: "error",
        };
        if (state.explicitUnavailable)
            return {
                profile: profileReadiness,
                summary: unavailable,
                transcription: unavailable,
            };
        const [summary, transcription] = await Promise.all([
            providerReadiness(
                userId,
                "summary",
                profile?.settings.steps.summary.provider ?? null,
                organizationDefaultsOnly,
                readOnlyAccess,
            ),
            channel === "audio"
                ? providerReadiness(
                      userId,
                      "transcription",
                      profile && "transcribe" in profile.settings.steps
                          ? profile.settings.steps.transcribe.provider
                          : null,
                      organizationDefaultsOnly,
                      readOnlyAccess,
                  )
                : Promise.resolve(unavailable),
        ]);
        return { profile: profileReadiness, summary, transcription };
    } catch {
        const unavailable: ProviderReadiness = {
            source: "none",
            name: null,
            status: "error",
        };
        return {
            profile: { status: "error", name: null } satisfies ProfileReadiness,
            summary: unavailable,
            transcription: unavailable,
        };
    }
}

async function plaudReadiness(userId: string): Promise<OnboardingStatus> {
    try {
        const [row] = await db
            .select({ invalidatedAt: plaudConnections.invalidatedAt })
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, userId))
            .limit(1);
        return plaudConnectionStatus(row ?? null);
    } catch {
        return "error";
    }
}

function plaudConnectionStatus(
    row: { invalidatedAt: Date | null } | null,
): OnboardingStatus {
    return row
        ? row.invalidatedAt
            ? "needs-reconnect"
            : "connected"
        : "not-connected";
}

async function checkOrganizationAccess(
    userId: string,
    readOnlyAccess: () => Promise<HolderAccess>,
): Promise<void> {
    if (!isOrgScopeEnabled() || !isIdpAuthorization()) return;
    const organizationId = await getOrgUserId();
    if (!organizationId || organizationId === userId) return;
    const access = await readOnlyAccess();
    if (!access.ok && access.reason === "unavailable") {
        throw new Error("Organization access could not be checked");
    }
}

async function googleReadiness(userId: string): Promise<OnboardingStatus> {
    try {
        const connection = await getGoogleConnectionStatus(userId);
        if (!connection) return "not-connected";
        if (connection.status !== "active") return "needs-reconnect";
        if (!connection.scopes.includes(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE))
            return "not-connected";
        return connection.scopes.includes(GOOGLE_MEET_READ_SCOPE)
            ? "connected"
            : "calendar-only";
    } catch {
        return "error";
    }
}

async function mailReadiness(
    userId: string,
): Promise<OnboardingReadiness["mail"]> {
    try {
        const mail = await loadMailSettings(userId, { provision: false });
        const address =
            mail.addresses.find((item) => item.kind === "mailbox")?.address ??
            null;
        return {
            status: !mail.eligible
                ? "ineligible"
                : !mail.receiving
                  ? "paused"
                  : address
                    ? "ready"
                    : "error",
            address,
        };
    } catch {
        return { status: "error", address: null };
    }
}

/** Read readiness without provisioning, decrypting API keys, or reserving AI calls. */
export async function loadOnboardingReadiness(
    userId: string,
    capabilities: OnboardingCapabilities,
    options: { plaudConnection?: { invalidatedAt: Date | null } | null } = {},
): Promise<OnboardingReadiness> {
    const personal = capabilities.audience !== "organization-account";
    let access: Promise<HolderAccess> | undefined;
    const readOnlyAccess = () => {
        access ??= holderAccess(userId, { readOnly: true });
        return access;
    };
    const accessCheck = checkOrganizationAccess(userId, readOnlyAccess);
    const [audio, mailProfile, plaud, google, mail] = await Promise.all([
        channelReadiness(
            userId,
            "audio",
            !personal,
            accessCheck,
            readOnlyAccess,
        ),
        capabilities.mailAvailable || !personal
            ? channelReadiness(
                  userId,
                  "mail",
                  !personal,
                  accessCheck,
                  readOnlyAccess,
              )
            : Promise.resolve(null),
        personal
            ? options.plaudConnection !== undefined
                ? Promise.resolve(
                      plaudConnectionStatus(options.plaudConnection),
                  )
                : plaudReadiness(userId)
            : Promise.resolve("not-connected" as const),
        personal && capabilities.googleConfigured
            ? googleReadiness(userId)
            : Promise.resolve("not-connected" as const),
        personal && capabilities.mailAvailable
            ? mailReadiness(userId)
            : Promise.resolve({
                  status: "not-connected" as const,
                  address: null,
              }),
    ]);
    return {
        ai: {
            transcription: audio.transcription,
            summary: audio.summary,
            mailSummary: mailProfile?.summary ?? null,
        },
        profiles: { audio: audio.profile, mail: mailProfile?.profile ?? null },
        plaud,
        google,
        mail,
    };
}
