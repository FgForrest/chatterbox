import {
    buildSeedProfiles,
    type LegacyProfileSettings,
} from "@/lib/profiles/seed";
import type { AudioProfileSettings } from "@/lib/profiles/settings";

const defaults: LegacyProfileSettings = {
    autoTranscribe: false,
    autoSummarize: false,
    autoSummarizePreset: null,
    summaryMultiPass: false,
    summaryMultiPassRounds: 3,
    summaryMultiPassAuto: false,
    summaryMergePrompt: null,
    defaultTranscriptionLanguage: null,
    transcriptionQuality: "balanced",
    transcriptMode: "plaud_only",
    autoGenerateTitle: true,
    titleGenerationPrompt: null,
    summaryPrompt: null,
    autoDetectTopics: false,
    autoLearn: false,
    correctAfterLearn: true,
    mailAutoProcess: true,
    topicPrompt: null,
    aiOutputLanguage: null,
};

export function seededAudioProfileSettings(
    overrides: Partial<LegacyProfileSettings> = {},
): AudioProfileSettings {
    const profile = buildSeedProfiles(
        { ...defaults, ...overrides },
        "personal",
    ).find((candidate) => candidate.channel === "audio" && candidate.isDefault);
    if (!profile || profile.channel !== "audio") {
        throw new Error("Seeded audio profile not found");
    }
    return profile.settings;
}

export function resolvedAudioProfile(
    overrides: Partial<LegacyProfileSettings> = {},
) {
    const settings = seededAudioProfileSettings(overrides);
    return {
        revisionId: "seeded-profile-revision",
        settings,
        profile: {
            id: "seeded-profile",
            ownerUserId: "user-1",
            scope: "personal" as const,
            channel: "audio" as const,
            name: "Recordings",
            description: null,
            isDefault: true,
            currentRevisionId: "seeded-profile-revision",
            archivedAt: null,
            createdBy: "user-1",
            updatedBy: "user-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
            settings,
        },
    };
}
