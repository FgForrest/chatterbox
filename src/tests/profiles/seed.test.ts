import { describe, expect, it, vi } from "vitest";
import { TITLE_TEMPLATE_KIND } from "@/lib/ai/prompt-presets";
import type {
    PromptTemplate,
    TemplateConfiguration,
} from "@/lib/ai/prompt-templates";
import { defaultTemplateConfig } from "@/lib/ai/prompt-templates";
import { SUMMARY_TEMPLATE_KIND } from "@/lib/ai/summary-presets";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { TOPIC_TEMPLATE_KIND } from "@/lib/topics/topic-presets";

vi.mock("@/db", () => ({
    db: { select: vi.fn(), transaction: vi.fn() },
}));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: vi.fn() }));
vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        IS_HOSTED: false,
        SELF_HOST_MODE: "shared",
    },
}));

import { db } from "@/db";
import { getOrgUserId } from "@/lib/org/config";
import {
    buildSeedProfiles,
    ensureProfiles,
    type LegacyProfileSettings,
    type SeedProfile,
} from "@/lib/profiles/seed";

function firstAudio(profiles: SeedProfile[]) {
    const profile = profiles.find(
        (entry): entry is Extract<SeedProfile, { channel: "audio" }> =>
            entry.channel === "audio",
    );
    if (!profile) throw new Error("missing audio profile");
    return profile;
}

function template(
    id: string,
    name: string | null,
    prompt: string | null,
): PromptTemplate {
    return { id, name, prompt, createdAt: "2026-10-14T00:00:00.000Z" };
}

function config(
    kind: Parameters<typeof defaultTemplateConfig>[0],
    selectedPrompt: string,
    additions: PromptTemplate[] = [],
): TemplateConfiguration {
    return {
        ...defaultTemplateConfig(kind),
        selectedPrompt,
        templates: [...defaultTemplateConfig(kind).templates, ...additions],
    };
}

function fixture(
    overrides: Partial<LegacyProfileSettings> = {},
): LegacyProfileSettings {
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
        titleGenerationPrompt: config(TITLE_TEMPLATE_KIND, "default"),
        summaryPrompt: config(SUMMARY_TEMPLATE_KIND, "general"),
        autoDetectTopics: false,
        autoLearn: false,
        correctAfterLearn: true,
        mailAutoProcess: true,
        topicPrompt: config(TOPIC_TEMPLATE_KIND, "default"),
        aiOutputLanguage: null,
        ...overrides,
    };
}

describe("legacy settings to profile seeds", () => {
    it("returns before opening a seed transaction when profiles already exist", async () => {
        vi.mocked(db.select).mockReturnValueOnce({
            from: () => ({
                where: () => ({
                    limit: () => Promise.resolve([{ id: "existing-profile" }]),
                }),
            }),
        } as unknown as ReturnType<typeof db.select>);

        await ensureProfiles("owner");

        expect(db.transaction).not.toHaveBeenCalled();
        expect(getOrgUserId).not.toHaveBeenCalled();
    });

    it("maps unedited presets without freezing their prompts", () => {
        const profiles = buildSeedProfiles(fixture(), "personal");
        const audio = profiles.find((profile) => profile.channel === "audio");

        expect(audio?.name).toBe("Recordings");
        expect(audio?.isDefault).toBe(true);
        expect(audio?.settings.steps.summary).toMatchObject({
            preset: "general",
            fullPrompt: null,
            outputLanguage: "auto",
        });
        expect(audio?.settings.steps.title.prompt).toEqual({});
        expect(audio?.settings.steps.topics.prompt).toEqual({});
    });

    it("maps edited presets and custom templates to complete prompts", () => {
        const titleConfig = config(TITLE_TEMPLATE_KIND, "default");
        titleConfig.templates = titleConfig.templates.map((entry) =>
            entry.id === "default"
                ? { ...entry, prompt: "Edited title" }
                : entry,
        );
        const topicConfig = config(TOPIC_TEMPLATE_KIND, "custom-topic", [
            template("custom-topic", "Custom topic", "Custom topics"),
        ]);
        const summaryConfig = config(SUMMARY_TEMPLATE_KIND, "custom-summary", [
            template("custom-summary", "Custom summary", "Complete summary"),
        ]);

        const profiles = buildSeedProfiles(
            fixture({
                titleGenerationPrompt: titleConfig,
                topicPrompt: topicConfig,
                summaryPrompt: summaryConfig,
            }),
            "personal",
        );
        const audio = firstAudio(profiles);

        expect(audio?.settings.steps.summary).toMatchObject({
            preset: "general",
            fullPrompt: "Complete summary",
        });
        expect(audio?.settings.steps.title).toMatchObject({
            prompt: {},
            fullPrompt: "Edited title",
        });
        expect(audio?.settings.steps.topics).toMatchObject({
            prompt: {},
            fullPrompt: "Custom topics",
        });

        const mail = profiles.find((profile) => profile.channel === "mail");
        expect(mail?.settings.steps.summary).toMatchObject({
            preset: "mail",
            fullPrompt: null,
        });
    });

    it("decrypts source columns and preserves an edited summary preset", () => {
        const summaryConfig = config(SUMMARY_TEMPLATE_KIND, "meeting-notes");
        summaryConfig.templates = summaryConfig.templates.map((entry) =>
            entry.id === "meeting-notes"
                ? { ...entry, prompt: "Complete edited meeting prompt" }
                : entry,
        );

        const audio = firstAudio(
            buildSeedProfiles(
                fixture({
                    summaryPrompt: encryptJsonField(summaryConfig),
                    titleGenerationPrompt: encryptJsonField(
                        config(TITLE_TEMPLATE_KIND, "default"),
                    ),
                    topicPrompt: encryptJsonField(
                        config(TOPIC_TEMPLATE_KIND, "default"),
                    ),
                    summaryMergePrompt: encryptText("Encrypted merge"),
                }),
                "personal",
            ),
        );

        expect(audio.settings.steps.summary).toMatchObject({
            preset: "meeting-notes",
            fullPrompt: "Complete edited meeting prompt",
            multiPass: { mergePrompt: "Encrypted merge" },
        });

        const mail = buildSeedProfiles(
            fixture({ summaryPrompt: summaryConfig }),
            "personal",
        ).find((profile) => profile.channel === "mail");
        expect(mail?.settings.steps.summary).toMatchObject({
            preset: "mail",
            fullPrompt: null,
        });
    });

    it("maps all automation, language, multi-pass, and transcript settings", () => {
        const audio = firstAudio(
            buildSeedProfiles(
                fixture({
                    autoTranscribe: true,
                    autoSummarize: true,
                    summaryMultiPass: true,
                    summaryMultiPassRounds: 5,
                    summaryMultiPassAuto: true,
                    summaryMergePrompt: "Merge these",
                    defaultTranscriptionLanguage: "cs",
                    transcriptionQuality: "accurate",
                    transcriptMode: "keep_both",
                    autoGenerateTitle: false,
                    autoDetectTopics: true,
                    autoLearn: true,
                    correctAfterLearn: false,
                    aiOutputLanguage: "cs",
                }),
                "personal",
            ),
        );

        expect(audio?.settings.steps).toMatchObject({
            transcribe: {
                automatic: true,
                provider: null,
                language: "cs",
                quality: "accurate",
                plaudTranscript: "also_transcribe",
            },
            learn: {
                automatic: true,
                provider: null,
                correctAfterLearn: false,
            },
            title: { automatic: false, provider: null },
            topics: { automatic: true, provider: null },
            summary: {
                automatic: true,
                provider: null,
                outputLanguage: "cs",
                multiPass: {
                    enabled: true,
                    rounds: 5,
                    automaticToo: true,
                    mergePrompt: "Merge these",
                },
            },
            tasks: { enabled: true },
        });
    });

    it.each([
        { legacyRounds: 1, seededRounds: 2 },
        { legacyRounds: 99, seededRounds: 5 },
    ])("clamps legacy multi-pass rounds outside the range: $legacyRounds", ({
        legacyRounds,
        seededRounds,
    }) => {
        const profiles = buildSeedProfiles(
            fixture({ summaryMultiPassRounds: legacyRounds }),
            "personal",
        );

        for (const profile of profiles) {
            expect(profile.settings.steps.summary.multiPass.rounds).toBe(
                seededRounds,
            );
        }
    });

    it.each([
        null,
        "auto",
    ])("normalizes output language %s to auto", (value) => {
        const audio = firstAudio(
            buildSeedProfiles(fixture({ aiOutputLanguage: value }), "personal"),
        );
        expect(audio?.settings.steps.summary.outputLanguage).toBe("auto");
    });

    it("splits different automatic and manual summaries", () => {
        const profiles = buildSeedProfiles(
            fixture({
                autoTranscribe: true,
                autoSummarize: true,
                autoSummarizePreset: "meeting-notes",
                autoGenerateTitle: true,
                autoDetectTopics: true,
                autoLearn: true,
            }),
            "personal",
        );
        const audio = profiles.filter((profile) => profile.channel === "audio");

        expect(
            audio.map(({ name, isDefault }) => ({ name, isDefault })),
        ).toEqual([
            { name: "Automatic", isDefault: true },
            { name: "Manual", isDefault: false },
        ]);
        expect(audio[0]?.settings.steps.summary.preset).toBe("meeting-notes");
        expect(audio[1]?.settings.steps.summary.preset).toBe("general");
        expect(audio[1]?.settings.steps.transcribe.automatic).toBe(false);
        expect(audio[1]?.settings.steps.summary.automatic).toBe(false);
        expect(audio[1]?.settings.steps.title.automatic).toBe(false);
        expect(audio[1]?.settings.steps.topics.automatic).toBe(false);
        expect(audio[1]?.settings.steps.learn.automatic).toBe(false);
    });

    it("seeds built-in profile names in Czech without translating custom names", () => {
        const summaryConfig = config(SUMMARY_TEMPLATE_KIND, "used", [
            template("used", "Vlastní šablona", "Used prompt"),
            template("extra", "Custom stays", "Extra prompt"),
        ]);
        const profiles = buildSeedProfiles(
            fixture({
                autoSummarizePreset: "meeting-notes",
                summaryPrompt: summaryConfig,
            }),
            "personal",
            "cs-CZ",
        );

        expect(profiles.map(({ name }) => name)).toEqual([
            "Automatický",
            "Ruční",
            "Custom stays",
            "Pošta",
        ]);
        expect(buildSeedProfiles(fixture(), "personal", "cs-CZ")[0]?.name).toBe(
            "Nahrávky",
        );
    });

    it("adds unused custom summaries with their names and automation off", () => {
        const summaryConfig = config(SUMMARY_TEMPLATE_KIND, "used", [
            template("used", "Used custom", "Used prompt"),
            template("extra", "Extra custom", "Extra prompt"),
        ]);
        const profiles = buildSeedProfiles(
            fixture({ summaryPrompt: summaryConfig }),
            "organization",
        );

        expect(profiles.map(({ name, scope }) => ({ name, scope }))).toEqual([
            { name: "Recordings", scope: "organization" },
            { name: "Extra custom", scope: "organization" },
            { name: "Mail", scope: "organization" },
        ]);
        const extra = profiles.find(({ name }) => name === "Extra custom");
        expect(extra?.settings.steps.summary.fullPrompt).toBe("Extra prompt");
        expect(extra?.settings.steps.summary.automatic).toBe(false);
    });

    it.each([
        { mailAutoProcess: true, autoLearn: true, summary: true, learn: true },
        {
            mailAutoProcess: true,
            autoLearn: false,
            summary: true,
            learn: false,
        },
        {
            mailAutoProcess: false,
            autoLearn: true,
            summary: false,
            learn: false,
        },
    ])("maps mail automation %#", (example) => {
        const mail = buildSeedProfiles(
            fixture({
                mailAutoProcess: example.mailAutoProcess,
                autoLearn: example.autoLearn,
            }),
            "personal",
        ).find((profile) => profile.channel === "mail");

        expect(mail?.settings.steps.summary.automatic).toBe(example.summary);
        expect(mail?.settings.steps.learn.automatic).toBe(example.learn);
        expect(mail?.settings.steps.title).toMatchObject({
            enabled: false,
            automatic: false,
        });
        expect(mail?.settings.steps).not.toHaveProperty("transcribe");
        expect(mail?.settings.steps).not.toHaveProperty("topics");
    });
});
