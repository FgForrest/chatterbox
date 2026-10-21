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
    isYourDefault?: boolean;
    isOrganizationDefault?: boolean;
    deleteDisposition?: "delete" | "tombstone" | null;
    version: number;
    canEdit: boolean;
    archivedAt: string | null;
    updatedAt: string;
}

export interface SettingsProfileDetail extends SettingsProfileSummary {
    settings: ProfileSettings;
}

export type SettingsProfileSection = "organization" | "personal" | "archived";

export interface SettingsProfileSectionPage {
    profiles: SettingsProfileSummary[];
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
}

export interface SettingsProfilesPage {
    sections?: Record<SettingsProfileSection, SettingsProfileSectionPage>;
    profiles: SettingsProfileSummary[];
    defaults?: {
        audio: SettingsProfileDefault;
        mail: SettingsProfileDefault;
        options: SettingsProfileDefaultOption[];
    };
    permissions: {
        canCreateOrganization: boolean;
        canCreatePersonal?: boolean;
    };
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
}

export interface SettingsProfileDefault {
    selected: string | null;
    organizationDefault: { id: string; name: string } | null;
    explicitUnavailable: boolean;
}

export interface SettingsProfileDefaultOption {
    id: string;
    name: string;
    channel: "audio" | "mail";
    scope: "personal" | "organization";
}

export interface SettingsProfileBuiltins {
    builtinPromptsVersion: string;
    builtins: {
        focus: Record<"en" | "cs-CZ", string>;
        outputFormat: Record<"en" | "cs-CZ", string>;
    };
}
