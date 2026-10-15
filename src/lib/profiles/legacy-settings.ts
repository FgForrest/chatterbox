import type { userSettings } from "@/db/schema";
import { isPresetId, resolveTemplate } from "@/lib/ai/prompt-templates";
import {
    normalizeSummaryPromptConfig,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";
import type { ActorContext } from "@/lib/authz/model";
import { decryptJsonField } from "@/lib/encryption/fields";
import { ensureProfiles } from "@/lib/profiles/seed";
import {
    type AudioProfileSettings,
    type MailProfileSettings,
    type ProfileChannel,
    parseProfileSettings,
} from "@/lib/profiles/settings";
import {
    getDefaultProfile,
    ProfilePermissionError,
    type ProfileRecord,
    ProfileVersionConflictError,
    updateProfile,
} from "@/lib/profiles/store";

/** These legacy automation fields remain supported for compatibility clients. */
export const LEGACY_PROFILE_FIELDS = new Set([
    "autoTranscribe",
    "transcriptMode",
    "autoSummarize",
    "autoSummarizePreset",
    "autoGenerateTitle",
    "autoDetectTopics",
    "autoLearn",
    "correctAfterLearn",
    "mailAutoProcess",
    "aiOutputLanguage",
]);

const AUDIO_FIELDS = new Set([
    "autoTranscribe",
    "transcriptMode",
    "autoSummarize",
    "autoSummarizePreset",
    "autoGenerateTitle",
    "autoDetectTopics",
    "autoLearn",
    "correctAfterLearn",
    "aiOutputLanguage",
]);

const MAIL_FIELDS = new Set([
    "mailAutoProcess",
    "autoLearn",
    "correctAfterLearn",
    "aiOutputLanguage",
]);

type StoredUserSettings = typeof userSettings.$inferSelect;

function requested(body: Record<string, unknown>, fields: Set<string>) {
    return [...fields].some((field) => body[field] !== undefined);
}

function applyShared(
    settings: AudioProfileSettings | MailProfileSettings,
    stored: StoredUserSettings,
    body: Record<string, unknown>,
): void {
    if (body.correctAfterLearn !== undefined) {
        settings.steps.learn.correctAfterLearn = stored.correctAfterLearn;
    }
    if (body.aiOutputLanguage !== undefined) {
        settings.steps.summary.outputLanguage =
            stored.aiOutputLanguage && stored.aiOutputLanguage !== "auto"
                ? stored.aiOutputLanguage
                : "auto";
    }
}

function applyAudio(
    current: ProfileRecord,
    stored: StoredUserSettings,
    body: Record<string, unknown>,
): AudioProfileSettings {
    const settings = structuredClone(
        parseProfileSettings("audio", current.settings),
    );
    applyShared(settings, stored, body);
    if (body.autoTranscribe !== undefined) {
        settings.steps.transcribe.automatic = stored.autoTranscribe;
    }
    if (body.transcriptMode !== undefined) {
        settings.steps.transcribe.plaudTranscript =
            stored.transcriptMode === "keep_both" ? "also_transcribe" : "use";
    }
    if (body.autoSummarize !== undefined) {
        settings.steps.summary.automatic = stored.autoSummarize;
    }
    if (body.autoSummarizePreset !== undefined) {
        const config = normalizeSummaryPromptConfig(
            decryptJsonField(stored.summaryPrompt),
        );
        const resolved = resolveTemplate(
            config,
            stored.autoSummarizePreset ?? config.selectedPrompt,
            SUMMARY_TEMPLATE_KIND,
        );
        const selected = config.templates.find(
            (template) => template.id === resolved.id,
        );
        const builtIn = isPresetId(SUMMARY_TEMPLATE_KIND, resolved.id);
        settings.steps.summary.preset = isPresetId(
            SUMMARY_TEMPLATE_KIND,
            resolved.id,
        )
            ? resolved.id
            : "general";
        settings.steps.summary.fullPrompt =
            builtIn && selected?.prompt === null ? null : resolved.prompt;
    }
    if (body.autoGenerateTitle !== undefined) {
        settings.steps.title.automatic = stored.autoGenerateTitle;
    }
    if (body.autoDetectTopics !== undefined) {
        settings.steps.topics.automatic = stored.autoDetectTopics;
    }
    if (body.autoLearn !== undefined) {
        settings.steps.learn.automatic = stored.autoLearn;
    }
    return settings;
}

function applyMail(
    current: ProfileRecord,
    stored: StoredUserSettings,
    body: Record<string, unknown>,
): MailProfileSettings {
    const settings = structuredClone(
        parseProfileSettings("mail", current.settings),
    );
    applyShared(settings, stored, body);
    if (body.mailAutoProcess !== undefined) {
        settings.steps.summary.automatic = stored.mailAutoProcess;
    }
    if (body.mailAutoProcess !== undefined || body.autoLearn !== undefined) {
        settings.steps.learn.automatic =
            stored.mailAutoProcess && stored.autoLearn;
    }
    return settings;
}

async function updateDefault(
    userId: string,
    channel: ProfileChannel,
    actor: ActorContext,
    stored: StoredUserSettings,
    body: Record<string, unknown>,
): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await getDefaultProfile(userId, channel, actor.actorId);
        if (!current) return;
        const settings =
            channel === "audio"
                ? applyAudio(current, stored, body)
                : applyMail(current, stored, body);
        try {
            await updateProfile({
                ownerUserId: userId,
                profileId: current.id,
                actor,
                expectedVersion: current.version,
                settings,
            });
            return;
        } catch (error) {
            if (
                !(error instanceof ProfileVersionConflictError) ||
                attempt === 2
            ) {
                throw error;
            }
        }
    }
}

/** Mirror one legacy settings request into each affected default profile. */
export async function writeLegacySettingsToProfiles(input: {
    userId: string;
    body: Record<string, unknown>;
    stored: StoredUserSettings;
    actor: ActorContext;
}): Promise<void> {
    if (
        ![...LEGACY_PROFILE_FIELDS].some(
            (field) => input.body[field] !== undefined,
        )
    ) {
        return;
    }
    await ensureProfiles(input.userId);
    if (requested(input.body, AUDIO_FIELDS)) {
        try {
            await updateDefault(
                input.userId,
                "audio",
                input.actor,
                input.stored,
                input.body,
            );
        } catch (error) {
            if (!(error instanceof ProfilePermissionError)) throw error;
        }
    }
    if (requested(input.body, MAIL_FIELDS)) {
        try {
            await updateDefault(
                input.userId,
                "mail",
                input.actor,
                input.stored,
                input.body,
            );
        } catch (error) {
            if (!(error instanceof ProfilePermissionError)) throw error;
        }
    }
}

/** Overlay legacy response fields from the owner's current default profiles. */
export async function readLegacySettingsFromProfiles(
    userId: string,
): Promise<Record<string, unknown>> {
    await ensureProfiles(userId);
    const [audio, mail] = await Promise.all([
        getDefaultProfile(userId, "audio", userId),
        getDefaultProfile(userId, "mail", userId),
    ]);
    const result: Record<string, unknown> = {};
    if (audio) {
        const settings = parseProfileSettings("audio", audio.settings);
        result.autoTranscribe = settings.steps.transcribe.automatic;
        result.transcriptMode =
            settings.steps.transcribe.plaudTranscript === "also_transcribe"
                ? "keep_both"
                : "plaud_only";
        result.autoSummarize = settings.steps.summary.automatic;
        result.autoSummarizePreset = settings.steps.summary.preset;
        result.autoGenerateTitle = settings.steps.title.automatic;
        result.autoDetectTopics = settings.steps.topics.automatic;
        result.autoLearn = settings.steps.learn.automatic;
        result.correctAfterLearn = settings.steps.learn.correctAfterLearn;
        result.aiOutputLanguage =
            settings.steps.summary.outputLanguage === "auto"
                ? null
                : settings.steps.summary.outputLanguage;
    }
    if (mail) {
        const settings = parseProfileSettings("mail", mail.settings);
        result.mailAutoProcess = settings.steps.summary.automatic;
    }
    return result;
}
