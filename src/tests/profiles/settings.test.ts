import { describe, expect, it } from "vitest";
import {
    defaultProfileSettings,
    type ProfileChannel,
    parseProfileSettings,
} from "@/lib/profiles/settings";
import {
    MULTI_PASS_ROUNDS_MAX,
    MULTI_PASS_ROUNDS_MIN,
} from "@/lib/summary/multi-pass";

describe("profile settings", () => {
    it("uses built-ins without prompt customizations", () => {
        const audio = defaultProfileSettings("audio");

        expect(audio).toMatchObject({
            schemaVersion: 2,
            steps: {
                transcribe: { provider: null, quality: "balanced" },
                title: { preset: "default", prompt: {}, fullPrompt: null },
                topics: { preset: "default", prompt: {}, fullPrompt: null },
                summary: {
                    preset: "general",
                    focus: null,
                    outputFormat: {},
                    fullPrompt: null,
                    outputLanguage: "auto",
                    multiPass: { enabled: false, rounds: 3 },
                },
            },
        });
    });

    it("omits audio-only steps and keeps automatic titles off for mail", () => {
        const mail = defaultProfileSettings("mail");

        expect(mail.steps).not.toHaveProperty("transcribe");
        expect(mail.steps).not.toHaveProperty("topics");
        expect(mail.steps.title.automatic).toBe(false);
        expect(mail.steps.summary).toMatchObject({
            preset: "mail",
            fullPrompt: null,
        });
    });

    it("accepts recording presets for mail but not the mail preset for audio", () => {
        const mail = defaultProfileSettings("mail");
        const recordingPresetMail = {
            ...mail,
            steps: {
                ...mail.steps,
                summary: { ...mail.steps.summary, preset: "general" },
            },
        };

        expect(parseProfileSettings("mail", recordingPresetMail)).toEqual(
            recordingPresetMail,
        );
        expect(() =>
            parseProfileSettings("audio", {
                ...defaultProfileSettings("audio"),
                steps: {
                    ...defaultProfileSettings("audio").steps,
                    summary: {
                        ...defaultProfileSettings("audio").steps.summary,
                        preset: "mail",
                    },
                },
            }),
        ).toThrow();
    });

    it.each([
        MULTI_PASS_ROUNDS_MIN - 1,
        MULTI_PASS_ROUNDS_MAX + 1,
    ])("rejects multi-pass rounds outside the bounded range: %s", (rounds) => {
        const mail = defaultProfileSettings("mail");

        expect(() =>
            parseProfileSettings("mail", {
                ...mail,
                steps: {
                    ...mail.steps,
                    summary: {
                        ...mail.steps.summary,
                        multiPass: { ...mail.steps.summary.multiPass, rounds },
                    },
                },
            }),
        ).toThrow();
    });

    it("rejects a mail profile carrying audio-only steps", () => {
        expect(() =>
            parseProfileSettings("mail", defaultProfileSettings("audio")),
        ).toThrow();
    });

    it("rejects unsupported channels at runtime", () => {
        expect(() =>
            parseProfileSettings(
                "video" as ProfileChannel,
                defaultProfileSettings("audio"),
            ),
        ).toThrow();
    });

    it("defaults missing title and topic full prompts in stored v1 revisions", () => {
        const audio = defaultProfileSettings("audio");
        const { fullPrompt: _titlePrompt, ...title } = audio.steps.title;
        const { fullPrompt: _topicPrompt, ...topics } = audio.steps.topics;

        const parsed = parseProfileSettings("audio", {
            ...audio,
            steps: { ...audio.steps, title, topics },
        });

        expect(parsed.steps.title.fullPrompt).toBeNull();
        expect(parsed.steps.topics.fullPrompt).toBeNull();
        expect(parsed.schemaVersion).toBe(2);
    });

    it("upgrades disabled v1 steps to non-automatic v2 steps", () => {
        const audio = defaultProfileSettings("audio");
        const v1 = {
            ...audio,
            schemaVersion: 1,
            steps: Object.fromEntries(
                Object.entries(audio.steps).map(([name, step]) => [
                    name,
                    name === "tasks"
                        ? step
                        : { ...step, enabled: name !== "summary" },
                ]),
            ),
        };

        const parsed = parseProfileSettings("audio", v1);

        expect(parsed.schemaVersion).toBe(2);
        expect(parsed.steps.summary.automatic).toBe(false);
        expect(parsed.steps.title.automatic).toBe(true);
        expect(parsed.steps.summary).not.toHaveProperty("enabled");
        expect(parsed.steps.tasks.enabled).toBe(true);
    });

    it("round-trips v2 settings while preserving the tasks switch", () => {
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.automatic = false;
        settings.steps.tasks.enabled = false;

        expect(
            parseProfileSettings("audio", JSON.parse(JSON.stringify(settings))),
        ).toEqual(settings);
    });

    it("accepts prompt overrides only for supported locales", () => {
        const mail = defaultProfileSettings("mail");
        const customized = {
            ...mail,
            steps: {
                ...mail.steps,
                title: {
                    ...mail.steps.title,
                    prompt: { en: "English", "cs-CZ": "Česky" },
                },
            },
        };

        expect(parseProfileSettings("mail", customized)).toEqual(customized);
        expect(() =>
            parseProfileSettings("mail", {
                ...customized,
                steps: {
                    ...customized.steps,
                    title: {
                        ...customized.steps.title,
                        prompt: { de: "Deutsch" },
                    },
                },
            }),
        ).toThrow();
    });
});
