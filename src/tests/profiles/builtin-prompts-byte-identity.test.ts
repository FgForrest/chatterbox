import { describe, expect, it } from "vitest";
import {
    MAIL_SUMMARY_PROMPT,
    MAIL_SUMMARY_PROMPT_PARTS,
} from "@/lib/ai/mail-summary-prompts";
import {
    PROMPT_PRESETS,
    TITLE_PROMPTS_BY_LOCALE,
} from "@/lib/ai/prompt-presets";
import {
    assembleSummaryPrompt,
    SUMMARY_PRESETS,
    SUMMARY_PROMPT_PARTS,
} from "@/lib/ai/summary-presets";
import {
    TOPIC_PRESETS,
    TOPIC_PROMPTS_BY_LOCALE,
} from "@/lib/topics/topic-presets";
import {
    ORIGINAL_MAIL_SUMMARY_PROMPT,
    ORIGINAL_SUMMARY_PROMPTS,
    ORIGINAL_TITLE_PROMPTS,
    ORIGINAL_TOPIC_PROMPTS,
} from "./fixtures/builtin-prompts";

describe("English built-in prompt byte identity", () => {
    it.each(
        Object.keys(ORIGINAL_SUMMARY_PROMPTS),
    )("keeps the %s summary preset byte-identical", (id) => {
        const preset = id as keyof typeof ORIGINAL_SUMMARY_PROMPTS;
        expect(assembleSummaryPrompt(SUMMARY_PROMPT_PARTS[preset], "en")).toBe(
            ORIGINAL_SUMMARY_PROMPTS[preset],
        );
        expect(SUMMARY_PRESETS[preset].prompt).toBe(
            ORIGINAL_SUMMARY_PROMPTS[preset],
        );
    });

    it("keeps the mail summary preset byte-identical", () => {
        expect(assembleSummaryPrompt(MAIL_SUMMARY_PROMPT_PARTS, "en")).toBe(
            ORIGINAL_MAIL_SUMMARY_PROMPT,
        );
        expect(MAIL_SUMMARY_PROMPT).toBe(ORIGINAL_MAIL_SUMMARY_PROMPT);
    });

    it.each(
        Object.keys(ORIGINAL_TITLE_PROMPTS),
    )("keeps the %s title preset byte-identical", (id) => {
        const preset = id as keyof typeof ORIGINAL_TITLE_PROMPTS;
        expect(TITLE_PROMPTS_BY_LOCALE[preset].en).toBe(
            ORIGINAL_TITLE_PROMPTS[preset],
        );
        expect(PROMPT_PRESETS[preset].prompt).toBe(
            ORIGINAL_TITLE_PROMPTS[preset],
        );
    });

    it("keeps the topic preset byte-identical", () => {
        expect(TOPIC_PROMPTS_BY_LOCALE.default.en).toBe(
            ORIGINAL_TOPIC_PROMPTS.default,
        );
        expect(TOPIC_PRESETS.default.prompt).toBe(
            ORIGINAL_TOPIC_PROMPTS.default,
        );
    });
});
