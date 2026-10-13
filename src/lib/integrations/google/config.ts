import { env } from "@/lib/env";

export const GOOGLE_DRIVE_FILE_SCOPE =
    "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE =
    "https://www.googleapis.com/auth/calendar.events.readonly";

/** Scopes asked for on connect. Later integrations add theirs incrementally. */
export const GOOGLE_CONNECT_SCOPES = [
    "openid",
    "email",
    GOOGLE_DRIVE_FILE_SCOPE,
];

export interface GoogleOAuthConfig {
    clientId: string;
    clientSecret: string;
    /** Lowercase Workspace domains allowed to connect; empty allows any. */
    workspaceDomains: string[];
    redirectUri: string;
}
export interface GoogleIntegrationConfig extends GoogleOAuthConfig {
    pickerApiKey: string;
    projectNumber: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
    if (
        env.IS_HOSTED ||
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.APP_URL
    ) {
        return null;
    }
    return {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        workspaceDomains: env.GOOGLE_WORKSPACE_DOMAINS ?? [],
        redirectUri: new URL(
            "/api/integrations/google/callback",
            env.APP_URL,
        ).toString(),
    };
}

/**
 * The Google integration's settings, or null where it is off: on hosted
 * deployments, and wherever any of the four required variables is unset.
 */
export function getGoogleIntegrationConfig(): GoogleIntegrationConfig | null {
    const oauth = getGoogleOAuthConfig();
    if (
        !oauth ||
        !env.GOOGLE_PICKER_API_KEY ||
        !env.GOOGLE_CLOUD_PROJECT_NUMBER
    )
        return null;
    return {
        ...oauth,
        pickerApiKey: env.GOOGLE_PICKER_API_KEY,
        projectNumber: env.GOOGLE_CLOUD_PROJECT_NUMBER,
    };
}

export function isGoogleIntegrationAvailable(): boolean {
    return getGoogleIntegrationConfig() !== null;
}
