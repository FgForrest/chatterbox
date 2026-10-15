import { z } from "zod";
import type { SummaryPreset } from "@/lib/ai/summary-presets";
import { type AppLocale, locales } from "@/lib/i18n/config";
import {
    MULTI_PASS_ROUNDS_MAX,
    MULTI_PASS_ROUNDS_MIN,
} from "@/lib/summary/multi-pass";
import type { TopicPreset } from "@/lib/topics/topic-presets";
import type { PromptPreset } from "@/types/ai";

export const profileChannels = ["audio", "mail"] as const;
export const profileChannelSchema = z.enum(profileChannels);
export type ProfileChannel = (typeof profileChannels)[number];
export type ProfileScope = "personal" | "organization";
export type Locale = AppLocale;
export const MAIL_SUMMARY_PROMPT_ID = "mail" as const;

const localeTextSchema = z
    .object(
        Object.fromEntries(
            locales.map((locale) => [locale, z.string().optional()]),
        ) as {
            [K in Locale]: z.ZodOptional<z.ZodString>;
        },
    )
    .strict();

const providerPinSchema = z
    .object({
        credentialId: z.string().min(1),
        scope: z.enum(["personal", "organization"]),
    })
    .strict();

export type ProviderPin = z.infer<typeof providerPinSchema>;

const commonStepSchema = {
    enabled: z.boolean(),
    automatic: z.boolean(),
    provider: providerPinSchema.nullable(),
};

const transcribeStepSchema = z
    .object({
        ...commonStepSchema,
        language: z.string().nullable(),
        quality: z.enum(["fast", "balanced", "accurate"]),
        plaudTranscript: z.enum(["use", "also_transcribe"]),
    })
    .strict();

const learnStepSchema = z
    .object({
        ...commonStepSchema,
        correctAfterLearn: z.boolean(),
    })
    .strict();

const titleStepSchema = z
    .object({
        ...commonStepSchema,
        preset: z.enum([
            "default",
            "meetings",
            "lectures",
            "phone-calls",
            "audio-blog",
            "idea-stormer",
        ]),
        prompt: localeTextSchema,
        fullPrompt: z.string().nullable().optional().default(null),
    })
    .strict();

const mailTitleStepSchema = titleStepSchema.extend({
    enabled: z.boolean().default(false),
});

const topicsStepSchema = z
    .object({
        ...commonStepSchema,
        preset: z.literal("default"),
        prompt: localeTextSchema,
        fullPrompt: z.string().nullable().optional().default(null),
    })
    .strict();

const recordingSummaryPresetSchema = z.enum([
    "general",
    "meeting-notes",
    "key-points",
    "action-items",
]);

const summaryStepSchema = z
    .object({
        ...commonStepSchema,
        preset: recordingSummaryPresetSchema,
        focus: z.string().nullable(),
        outputFormat: localeTextSchema,
        fullPrompt: z.string().nullable(),
        outputLanguage: z.string(),
        multiPass: z
            .object({
                enabled: z.boolean(),
                rounds: z
                    .number()
                    .int()
                    .min(MULTI_PASS_ROUNDS_MIN)
                    .max(MULTI_PASS_ROUNDS_MAX),
                automaticToo: z.boolean(),
                mergePrompt: z.string().nullable(),
            })
            .strict(),
    })
    .strict();

const mailSummaryStepSchema = summaryStepSchema.extend({
    preset: z.union([
        z.literal(MAIL_SUMMARY_PROMPT_ID),
        recordingSummaryPresetSchema,
    ]),
});

const tasksStepSchema = z.object({ enabled: z.boolean() }).strict();

const sharedSteps = {
    learn: learnStepSchema,
    title: titleStepSchema,
    tasks: tasksStepSchema,
};

export const audioProfileSettingsSchema = z
    .object({
        schemaVersion: z.literal(1),
        steps: z
            .object({
                transcribe: transcribeStepSchema,
                ...sharedSteps,
                summary: summaryStepSchema,
                topics: topicsStepSchema,
            })
            .strict(),
    })
    .strict();

export const mailProfileSettingsSchema = z
    .object({
        schemaVersion: z.literal(1),
        steps: z
            .object({
                ...sharedSteps,
                title: mailTitleStepSchema,
                summary: mailSummaryStepSchema,
            })
            .strict(),
    })
    .strict();

export const profileSettingsSchema = z.union([
    audioProfileSettingsSchema,
    mailProfileSettingsSchema,
]);

export type AudioProfileSettings = z.infer<typeof audioProfileSettingsSchema>;
export type MailProfileSettings = z.infer<typeof mailProfileSettingsSchema>;
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

function sharedDefaults() {
    return {
        learn: {
            enabled: true,
            automatic: false,
            provider: null,
            correctAfterLearn: true,
        },
        title: {
            enabled: true,
            automatic: true,
            provider: null,
            preset: "default" as PromptPreset,
            prompt: {},
            fullPrompt: null,
        },
        summary: {
            enabled: true,
            automatic: false,
            provider: null,
            preset: "general" as SummaryPreset,
            focus: null,
            outputFormat: {},
            fullPrompt: null,
            outputLanguage: "auto",
            multiPass: {
                enabled: false,
                rounds: 3,
                automaticToo: false,
                mergePrompt: null,
            },
        },
        tasks: { enabled: true },
    };
}

/** Return a profile with built-in prompts and no prompt customizations. */
export function defaultProfileSettings(channel: "audio"): AudioProfileSettings;
export function defaultProfileSettings(channel: "mail"): MailProfileSettings;
export function defaultProfileSettings(
    channel: ProfileChannel,
): ProfileSettings;
export function defaultProfileSettings(
    channel: ProfileChannel,
): ProfileSettings {
    const shared = sharedDefaults();
    if (channel === "mail") {
        return {
            schemaVersion: 1,
            steps: {
                ...shared,
                summary: {
                    ...shared.summary,
                    preset: MAIL_SUMMARY_PROMPT_ID,
                    fullPrompt: null,
                },
                title: { ...shared.title, enabled: false, automatic: false },
            },
        };
    }
    return {
        schemaVersion: 1,
        steps: {
            transcribe: {
                enabled: true,
                automatic: false,
                provider: null,
                language: null,
                quality: "balanced",
                plaudTranscript: "use",
            },
            ...shared,
            topics: {
                enabled: true,
                automatic: false,
                provider: null,
                preset: "default" as TopicPreset,
                prompt: {},
                fullPrompt: null,
            },
        },
    };
}

/** Parse encrypted revision contents against the profile's channel. */
export function parseProfileSettings(
    channel: "audio",
    value: unknown,
): AudioProfileSettings;
export function parseProfileSettings(
    channel: "mail",
    value: unknown,
): MailProfileSettings;
export function parseProfileSettings(
    channel: ProfileChannel,
    value: unknown,
): ProfileSettings;
export function parseProfileSettings(
    channel: ProfileChannel,
    value: unknown,
): ProfileSettings {
    const parsedChannel = profileChannelSchema.parse(channel);
    return parsedChannel === "audio"
        ? audioProfileSettingsSchema.parse(value)
        : mailProfileSettingsSchema.parse(value);
}
