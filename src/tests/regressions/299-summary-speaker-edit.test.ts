import { describe, expect, it } from "vitest";
import {
    canonicalizeSummarySpeakerReferences,
    inferSummarySpeakerNumberOffset,
    projectSummarySpeakerReferencesForExport,
    storeEditedSpeakerReferences,
    summarySpeakerReferencesForEditor,
} from "@/lib/knowledge/speaker-references";

describe("#299 summary speaker edit round trip", () => {
    it("normalizes a saved offset to the transcript numbering before revision", () => {
        expect(
            canonicalizeSummarySpeakerReferences(
                "[Speaker 1](#speaker-1) agreed. Speaker 2 listened.",
                -1,
            ),
        ).toBe(
            "[Speaker 0](#speaker-0) agreed. [Speaker 1](#speaker-1) listened.",
        );
    });
    it("resolves attributed names in the editor while keeping the original href and zero-based offset", () => {
        const stored = "[Speaker 1](#speaker-1) met [Speaker 2](#speaker-2).";
        const labels = ["speaker_0", "speaker_1"];
        const attributions = {
            speaker_0: { personId: "person-a", name: "Jitka Dvořáková" },
            speaker_1: { personId: "person-b", name: "Tomáš Kraus" },
        };
        const offset = inferSummarySpeakerNumberOffset(stored, labels);
        expect(offset).toBe(-1);
        const editing = summarySpeakerReferencesForEditor(
            stored,
            attributions,
            offset,
        );
        expect(editing).toBe(
            "[Jitka Dvořáková](#speaker-1) met [Tomáš Kraus](#speaker-2).",
        );
        const saved = storeEditedSpeakerReferences(
            `${editing}\nJitka Dvořáková added a note.`,
        );
        expect(saved).toBe(`${stored}\nJitka Dvořáková added a note.`);
        expect(inferSummarySpeakerNumberOffset(saved, labels)).toBe(-1);
        expect(
            projectSummarySpeakerReferencesForExport(
                saved,
                (label) => (label === "speaker_0" ? "New name" : "Tomáš Kraus"),
                offset,
            ),
        ).toContain("New name met Tomáš Kraus");
    });

    it("canonicalizes arbitrary link labels and leaves unlinked names and other links untouched", () => {
        expect(
            storeEditedSpeakerReferences(
                "[Changed name](#speaker-0) and Plain Name, [site](https://example.com).",
            ),
        ).toBe(
            "[Speaker 0](#speaker-0) and Plain Name, [site](https://example.com).",
        );
    });

    it("escapes Markdown in attributed names and round trips it", () => {
        const stored = "[Speaker 12](#speaker-12)";
        const editing = summarySpeakerReferencesForEditor(stored, {
            speaker_12: { personId: "p", name: "Name [team]" },
        });
        expect(editing).toBe("[Name \\[team\\]](#speaker-12)");
        expect(storeEditedSpeakerReferences(editing)).toBe(stored);
    });
});
