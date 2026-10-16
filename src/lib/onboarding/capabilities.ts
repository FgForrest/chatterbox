/** Integration capabilities available to the signed-in user during setup. */
export interface OnboardingCapabilities {
    googleConfigured: boolean;
    mailAvailable: boolean;
    mcpConnectorUrl: string | null;
    recorderStoreUrl: string;
}

/** Whether onboarding should open automatically for the stored user setting. */
export function shouldOpenOnboarding(onboardingCompleted: boolean): boolean {
    return !onboardingCompleted;
}
