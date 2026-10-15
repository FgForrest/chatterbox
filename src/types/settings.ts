/**
 * Settings types
 */

import type { ProfileSettings } from "@/lib/profiles/settings";

export type SettingsSection =
    | "providers"
    | "api-keys"
    | "recorder"
    | "webhooks"
    | "transcription"
    | "topics"
    | "learning"
    | "summary"
    | "profiles"
    | "storage"
    | "sync"
    | "plaud-account"
    | "playback"
    | "display"
    | "notifications"
    | "export"
    | "billing"
    | "google-account"
    | "mail"
    | "access"
    | "dev";

export interface SettingsProfileSummary {
    id: string;
    name: string;
    description: string | null;
    channel: "audio" | "mail";
    scope: "personal" | "organization";
    isDefault: boolean;
    version: number;
    canEdit: boolean;
    archivedAt: string | null;
    updatedAt: string;
}

export interface SettingsProfileDetail extends SettingsProfileSummary {
    settings: ProfileSettings;
}

export interface SettingsProfilesPage {
    profiles: SettingsProfileSummary[];
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
}

export interface SettingsProfileBuiltins {
    builtinPromptsVersion: string;
    builtins: {
        focus: Record<"en" | "cs-CZ", string>;
        outputFormat: Record<"en" | "cs-CZ", string>;
    };
}
