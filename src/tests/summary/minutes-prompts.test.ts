import { describe, expect, it, vi } from "vitest";
import {
    assembleSummaryPrompt,
    localizedSummaryPrompt,
    SUMMARY_MARKDOWN_DIRECTIVE,
    SUMMARY_PRESETS,
    SUMMARY_PROMPT_PARTS,
} from "@/lib/ai/summary-presets";
import {
    SUMMARY_TASKS_DIRECTIVE,
    SUMMARY_TASKS_MERGE_DIRECTIVE,
} from "@/lib/tasks/directive";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));

describe("minutes prompt contracts", () => {
    it.each([
        "general",
        "meeting-notes",
    ] as const)("uses the same localized built-in in both paths for %s", (preset) => {
        for (const [language, locale] of [
            ["cs", "cs-CZ"],
            ["en", "en"],
        ] as const) {
            expect(
                localizedSummaryPrompt(
                    preset,
                    SUMMARY_PRESETS[preset].prompt,
                    language,
                    true,
                ),
            ).toBe(assembleSummaryPrompt(SUMMARY_PROMPT_PARTS[preset], locale));
        }
        expect(
            localizedSummaryPrompt(preset, "Custom format", "cs", false),
        ).toBe("Custom format");
    });

    it.each([
        "general",
        "meeting-notes",
    ] as const)("extracts task objects before the minutes for %s", (preset) => {
        for (const locale of ["en", "cs-CZ"] as const) {
            const text = assembleSummaryPrompt(
                SUMMARY_PROMPT_PARTS[preset],
                locale,
            );
            expect(text.indexOf('"actionItems"')).toBeLessThan(
                text.indexOf('"summary"'),
            );
            expect(text).toContain('"candidates": null');
            expect(text.lastIndexOf("actionItems")).toBeGreaterThan(
                text.indexOf("{transcription}"),
            );
        }
    });

    it("keeps short recordings and lectures distinct from working meetings", () => {
        const format = SUMMARY_PROMPT_PARTS.general.outputFormat.en;
        expect(format).toContain("one tight paragraph");
        expect(format).toContain(
            "long monologue or lecture gets topic sections",
        );
        expect(format).toContain("Even a meeting focused on one topic");
        expect(SUMMARY_MARKDOWN_DIRECTIVE).toContain(
            "including meetings about one main topic",
        );
        expect(SUMMARY_MARKDOWN_DIRECTIVE).toContain(
            "Do not restate the key points or action items",
        );
        expect(SUMMARY_MARKDOWN_DIRECTIVE).toContain("single line");
        expect(SUMMARY_MARKDOWN_DIRECTIVE).toContain("one raw JSON object");
    });

    it("asks for complete commitment recall while retaining field and folding rules", () => {
        expect(SUMMARY_TASKS_DIRECTIVE).toContain(
            "whole transcript from beginning to end",
        );
        expect(SUMMARY_TASKS_DIRECTIVE).toContain("even without a reply");
        expect(SUMMARY_TASKS_DIRECTIVE).toContain("accepted requests");
        expect(SUMMARY_TASKS_DIRECTIVE).toContain("investigations to make");
        expect(SUMMARY_TASKS_DIRECTIVE).toContain(
            "decisions someone has to take",
        );
        expect(SUMMARY_TASKS_DIRECTIVE).toContain(
            "One entry per deliverable per person",
        );
        expect(SUMMARY_TASKS_DIRECTIVE).toContain(
            "hypothetical examples, demonstrations",
        );
        expect(SUMMARY_TASKS_DIRECTIVE).not.toContain("rarely holds");
        for (const field of [
            "speaker",
            "assignee",
            "due",
            "quote",
            "candidates",
        ]) {
            expect(SUMMARY_TASKS_DIRECTIVE).toContain(`"${field}"`);
            expect(SUMMARY_TASKS_MERGE_DIRECTIVE).toContain(field);
        }
        expect(SUMMARY_TASKS_DIRECTIVE).toContain(
            'name exactly as said in "assignee"',
        );
        expect(SUMMARY_TASKS_MERGE_DIRECTIVE).toContain(
            "Preserve every supported commitment",
        );
        expect(SUMMARY_TASKS_MERGE_DIRECTIVE).toContain(
            "conditional maybes and already completed work",
        );
        expect(SUMMARY_TASKS_MERGE_DIRECTIVE).toContain("one per");
    });
});
