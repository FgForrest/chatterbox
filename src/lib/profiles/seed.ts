import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { lockProfileSeedOwner } from "@/db/queries/profiles";
import {
    processingProfileRevisions,
    processingProfiles,
    userSettings,
} from "@/db/schema";
import {
    normalizeTitlePromptConfig,
    TITLE_TEMPLATE_KIND,
} from "@/lib/ai/prompt-presets";
import {
    isPresetId,
    type PromptTemplate,
    resolveTemplate,
    type TemplateConfiguration,
    type TemplateKind,
    templatePrompt,
} from "@/lib/ai/prompt-templates";
import {
    normalizeSummaryPromptConfig,
    SUMMARY_TEMPLATE_KIND,
    type SummaryPreset,
} from "@/lib/ai/summary-presets";
import {
    decryptJsonField,
    decryptText,
    encryptText,
} from "@/lib/encryption/fields";
import { locales } from "@/lib/i18n/config";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import {
    type AudioProfileSettings,
    defaultProfileSettings,
    type Locale,
    MAIL_SUMMARY_PROMPT_ID,
    type MailProfileSettings,
    type ProfileScope,
    parseProfileSettings,
} from "@/lib/profiles/settings";
import { clampRounds } from "@/lib/summary/multi-pass";
import {
    normalizeTopicPromptConfig,
    TOPIC_TEMPLATE_KIND,
} from "@/lib/topics/topic-presets";
import type { PromptPreset } from "@/types/ai";

export interface LegacyProfileSettings {
    autoTranscribe: boolean;
    autoSummarize: boolean;
    autoSummarizePreset: string | null;
    summaryMultiPass: boolean;
    summaryMultiPassRounds: number;
    summaryMultiPassAuto: boolean;
    summaryMergePrompt: string | null;
    defaultTranscriptionLanguage: string | null;
    transcriptionQuality: string;
    transcriptMode: string;
    autoGenerateTitle: boolean;
    titleGenerationPrompt: unknown;
    summaryPrompt: unknown;
    autoDetectTopics: boolean;
    autoLearn: boolean;
    correctAfterLearn: boolean;
    mailAutoProcess: boolean;
    topicPrompt: unknown;
    aiOutputLanguage: string | null;
}

export type SeedProfile =
    | {
          name: string;
          description: null;
          scope: ProfileScope;
          channel: "audio";
          isDefault: boolean;
          settings: AudioProfileSettings;
      }
    | {
          name: string;
          description: null;
          scope: ProfileScope;
          channel: "mail";
          isDefault: boolean;
          settings: MailProfileSettings;
      };

interface ResolvedTemplate<P extends string> {
    id: string;
    preset: P;
    prompt: string;
    fullPrompt: string | null;
}

function resolveStoredTemplate<P extends string>(
    config: TemplateConfiguration,
    requestedId: string | null | undefined,
    kind: TemplateKind<P>,
): ResolvedTemplate<P> {
    const resolved = resolveTemplate(config, requestedId, kind);
    const stored = config.templates.find(({ id }) => id === resolved.id);
    const uneditedBuiltIn = Boolean(
        stored && isPresetId(kind, stored.id) && stored.prompt === null,
    );
    const preset = isPresetId(kind, resolved.id)
        ? resolved.id
        : kind.fallbackId;
    return {
        id: resolved.id,
        preset,
        prompt: stored ? templatePrompt(stored, kind) : resolved.prompt,
        fullPrompt: uneditedBuiltIn ? null : resolved.prompt,
    };
}

function promptByLocale(prompt: string): Partial<Record<Locale, string>> {
    return Object.fromEntries(locales.map((locale) => [locale, prompt]));
}

function legacyValue<T>(value: unknown): T | null {
    return decryptJsonField<T>(value);
}

function audioSettings(
    legacy: LegacyProfileSettings,
    summaryConfig: TemplateConfiguration,
    summaryId: string | null | undefined,
): AudioProfileSettings {
    const settings = defaultProfileSettings("audio");
    const summary = resolveStoredTemplate(
        summaryConfig,
        summaryId,
        SUMMARY_TEMPLATE_KIND,
    );
    const title = resolveStoredTemplate(
        normalizeTitlePromptConfig(legacyValue(legacy.titleGenerationPrompt)),
        undefined,
        TITLE_TEMPLATE_KIND,
    );
    const topics = resolveStoredTemplate(
        normalizeTopicPromptConfig(legacyValue(legacy.topicPrompt)),
        undefined,
        TOPIC_TEMPLATE_KIND,
    );
    const quality = ["fast", "balanced", "accurate"].includes(
        legacy.transcriptionQuality,
    )
        ? (legacy.transcriptionQuality as "fast" | "balanced" | "accurate")
        : "balanced";

    settings.steps.transcribe = {
        ...settings.steps.transcribe,
        automatic: legacy.autoTranscribe,
        language: legacy.defaultTranscriptionLanguage,
        quality,
        plaudTranscript:
            legacy.transcriptMode === "keep_both" ? "also_transcribe" : "use",
    };
    settings.steps.learn = {
        ...settings.steps.learn,
        automatic: legacy.autoLearn,
        correctAfterLearn: legacy.correctAfterLearn,
    };
    settings.steps.title = {
        ...settings.steps.title,
        automatic: legacy.autoGenerateTitle,
        preset: title.preset as PromptPreset,
        prompt: title.fullPrompt ? promptByLocale(title.prompt) : {},
    };
    settings.steps.topics = {
        ...settings.steps.topics,
        automatic: legacy.autoDetectTopics,
        preset: topics.preset,
        prompt: topics.fullPrompt ? promptByLocale(topics.prompt) : {},
    };
    settings.steps.summary = {
        ...settings.steps.summary,
        automatic: legacy.autoSummarize,
        preset: summary.preset as SummaryPreset,
        fullPrompt: summary.fullPrompt,
        outputLanguage:
            legacy.aiOutputLanguage && legacy.aiOutputLanguage !== "auto"
                ? legacy.aiOutputLanguage
                : "auto",
        multiPass: {
            enabled: legacy.summaryMultiPass,
            rounds: clampRounds(legacy.summaryMultiPassRounds),
            automaticToo: legacy.summaryMultiPassAuto,
            mergePrompt: decryptText(legacy.summaryMergePrompt) ?? null,
        },
    };
    return parseProfileSettings("audio", settings);
}

function withoutAutomation(
    settings: AudioProfileSettings,
): AudioProfileSettings {
    return {
        ...settings,
        steps: {
            ...settings.steps,
            transcribe: { ...settings.steps.transcribe, automatic: false },
            learn: { ...settings.steps.learn, automatic: false },
            title: { ...settings.steps.title, automatic: false },
            topics: { ...settings.steps.topics, automatic: false },
            summary: { ...settings.steps.summary, automatic: false },
        },
    };
}

function mailSettings(legacy: LegacyProfileSettings): MailProfileSettings {
    const settings = defaultProfileSettings("mail");
    const title = resolveStoredTemplate(
        normalizeTitlePromptConfig(legacyValue(legacy.titleGenerationPrompt)),
        undefined,
        TITLE_TEMPLATE_KIND,
    );
    settings.steps.learn = {
        ...settings.steps.learn,
        automatic: legacy.mailAutoProcess && legacy.autoLearn,
        correctAfterLearn: legacy.correctAfterLearn,
    };
    settings.steps.title = {
        ...settings.steps.title,
        enabled: false,
        automatic: false,
        preset: title.preset as PromptPreset,
        prompt: title.fullPrompt ? promptByLocale(title.prompt) : {},
    };
    settings.steps.summary = {
        ...settings.steps.summary,
        automatic: legacy.mailAutoProcess,
        preset: MAIL_SUMMARY_PROMPT_ID,
        fullPrompt: null,
        outputLanguage:
            legacy.aiOutputLanguage && legacy.aiOutputLanguage !== "auto"
                ? legacy.aiOutputLanguage
                : "auto",
        multiPass: {
            enabled: legacy.summaryMultiPass,
            rounds: clampRounds(legacy.summaryMultiPassRounds),
            automaticToo: legacy.summaryMultiPassAuto,
            mergePrompt: decryptText(legacy.summaryMergePrompt) ?? null,
        },
    };
    return parseProfileSettings("mail", settings);
}

function customSummaryTemplates(
    config: TemplateConfiguration,
): PromptTemplate[] {
    return config.templates.filter(
        (entry) => !isPresetId(SUMMARY_TEMPLATE_KIND, entry.id),
    );
}

/** Convert one legacy user-settings row into the profiles that preserve its behavior. */
export function buildSeedProfiles(
    legacy: LegacyProfileSettings,
    scope: ProfileScope,
): SeedProfile[] {
    const summaryConfig = normalizeSummaryPromptConfig(
        legacyValue(legacy.summaryPrompt),
    );
    const selected = resolveStoredTemplate(
        summaryConfig,
        undefined,
        SUMMARY_TEMPLATE_KIND,
    );
    const automatic = resolveStoredTemplate(
        summaryConfig,
        legacy.autoSummarizePreset,
        SUMMARY_TEMPLATE_KIND,
    );
    const split =
        legacy.autoSummarizePreset !== null && automatic.id !== selected.id;
    const usedSummaryIds = new Set<string>();
    const result: SeedProfile[] = [];

    if (split) {
        usedSummaryIds.add(automatic.id);
        usedSummaryIds.add(selected.id);
        result.push({
            name: "Automatic",
            description: null,
            scope,
            channel: "audio",
            isDefault: true,
            settings: audioSettings(
                legacy,
                summaryConfig,
                legacy.autoSummarizePreset,
            ),
        });
        result.push({
            name: "Manual",
            description: null,
            scope,
            channel: "audio",
            isDefault: false,
            settings: withoutAutomation(
                audioSettings(legacy, summaryConfig, undefined),
            ),
        });
    } else {
        usedSummaryIds.add(selected.id);
        result.push({
            name: "Recordings",
            description: null,
            scope,
            channel: "audio",
            isDefault: true,
            settings: audioSettings(legacy, summaryConfig, undefined),
        });
    }

    for (const custom of customSummaryTemplates(summaryConfig)) {
        if (usedSummaryIds.has(custom.id)) continue;
        result.push({
            name: custom.name ?? custom.id,
            description: null,
            scope,
            channel: "audio",
            isDefault: false,
            settings: withoutAutomation(
                audioSettings(legacy, summaryConfig, custom.id),
            ),
        });
    }

    result.push({
        name: "Mail",
        description: null,
        scope,
        channel: "mail",
        isDefault: true,
        settings: mailSettings(legacy),
    });
    return result;
}

function defaultLegacySettings(): LegacyProfileSettings {
    return {
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
}

/** Lazily seed one owner's legacy settings into immutable profile revisions. */
export async function ensureProfiles(userId: string): Promise<void> {
    const orgUserId = isOrgScopeEnabled() ? await getOrgUserId() : null;
    const scope: ProfileScope =
        orgUserId === userId ? "organization" : "personal";

    await db.transaction(async (tx) => {
        await lockProfileSeedOwner(tx, userId);
        const existing = await tx
            .select({ id: processingProfiles.id })
            .from(processingProfiles)
            .where(eq(processingProfiles.ownerUserId, userId))
            .limit(1);
        if (existing.length > 0) return;

        const [stored] = await tx
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        const legacy: LegacyProfileSettings = stored ?? defaultLegacySettings();

        for (const profile of buildSeedProfiles(legacy, scope)) {
            const profileId = nanoid();
            const revisionId = nanoid();
            const inserted = await tx
                .insert(processingProfiles)
                .values({
                    id: profileId,
                    ownerUserId: userId,
                    scope: profile.scope,
                    channel: profile.channel,
                    name: encryptText(profile.name),
                    description: encryptText(profile.description),
                    isDefault: profile.isDefault,
                    currentRevisionId: revisionId,
                    createdBy: userId,
                    updatedBy: userId,
                })
                .onConflictDoNothing()
                .returning({ id: processingProfiles.id });
            if (inserted.length === 0) continue;
            await tx.insert(processingProfileRevisions).values({
                id: revisionId,
                profileId,
                settings: encryptText(JSON.stringify(profile.settings)),
                createdBy: userId,
            });
        }
    });
}
