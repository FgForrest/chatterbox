/** Integration capabilities available to the signed-in user during setup. */
export interface OnboardingCapabilities {
    audience: "single-user" | "organization-member" | "organization-account";
    googleConfigured: boolean;
    mailAvailable: boolean;
    mcpConnectorUrl: string | null;
    recorderStoreUrl: string;
}

export type OnboardingStatus =
    | "checking"
    | "error"
    | "connected"
    | "calendar-only"
    | "not-connected"
    | "needs-reconnect"
    | "ready"
    | "paused"
    | "ineligible"
    | "available"
    | "confirmed"
    | "skipped";

export interface ProviderReadiness {
    source: "own" | "organization" | "managed" | "none";
    name: string | null;
    status: "ready" | "not-connected" | "error";
}

export interface ProfileReadiness {
    status: "ready" | "not-connected" | "error";
    name: string | null;
}

/** Sanitized readiness; no credentials, tokens, or provider connection details. */
export interface OnboardingReadiness {
    plaud: OnboardingStatus;
    google: OnboardingStatus;
    ai: {
        transcription: ProviderReadiness;
        summary: ProviderReadiness;
        mailSummary: ProviderReadiness | null;
    };
    profiles: { audio: ProfileReadiness; mail: ProfileReadiness | null };
    mail: { status: OnboardingStatus; address: string | null };
}

/** Whether onboarding should open automatically for the stored user setting. */
export function shouldOpenOnboarding(onboardingCompleted: boolean): boolean {
    return !onboardingCompleted;
}
