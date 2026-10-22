/**
 * The summary the model writes is rendered as Markdown, and the instructions
 * that get it there are easy to lose.
 *
 * The system prompt used to end with "no markdown formatting or code fences".
 * That rule is about the ENVELOPE -- the reply must be a bare JSON object --
 * but models apply it to the prose inside the object too, which is why
 * summaries came back as one undifferentiated paragraph with the structure
 * inlined as "1) ... 2) ... 3)".
 *
 * These pin both halves: the envelope rule survives, and the formatting
 * permission reaches the model on the single-pass path, the multi-pass merge,
 * and a prompt the user wrote themselves (which cannot be edited to say so).
 */

import type * as OpenAIModule from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import {
    assembleSummaryPrompt,
    SUMMARY_MARKDOWN_DIRECTIVE,
    SUMMARY_PROMPT_PARTS,
    SUMMARY_SPEAKER_DIRECTIVE,
} from "@/lib/ai/summary-presets";
import type { LegacyProfileSettings } from "@/lib/profiles/seed";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { resolvedAudioProfile } from "@/tests/profiles/seeded-profile-fixture";

// Without corrections a model reads the stored text as it is.
// Task proposals read and write the database; covered on their own.
// Mail's masking reads mail configuration; no mail is summarized here.
vi.mock("@/lib/mail/redact", () => ({
    maskedContentForModel: async (content: unknown) => content,
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("@/lib/tasks/access", () => ({
    taskViewerById: vi.fn(async () => ({})),
}));
vi.mock("@/lib/tasks/proposals", () => ({
    loadTasksPromptContext: vi.fn(async () => ({ text: "", refs: new Map() })),
    resolveTaskProposals: vi.fn(async () => undefined),
}));

vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: vi.fn(async (transcript: { text: string }) => ({
        text: transcript.text,
        turns: null,
        fingerprint: null,
    })),
    llmRendering: vi.fn(async () => null),
}));
// Organization curation is decided against verified access; these
// runs are on the private view.
vi.mock("@/lib/authz/curator", () => ({
    actsForOrganization: vi.fn().mockResolvedValue(false),
    userCuratesOrganizationNow: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/org/config", () => ({
    isOrgScopeVisible: () => false,
    isOrgScopeEnabled: () => false,
    getOrgUserId: async () => null,
    assertOrgScopeWritable: () => {},
    isOrgAccount: async () => false,
    assertNotOrgAccount: async () => {},
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, ORG_PROVIDER_CALLS_PER_MEMBER_PER_HOUR: 60 },
}));

const { createMock, profileLegacy } = vi.hoisted(() => ({
    createMock: vi.fn(),
    profileLegacy: {
        current: {} as Partial<LegacyProfileSettings>,
    },
}));

vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: vi.fn(async () =>
        resolvedAudioProfile(profileLegacy.current),
    ),
}));
vi.mock("@/lib/pipeline/trigger", () => ({
    requestAdvanceInTx: vi.fn().mockResolvedValue(null),
}));

vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof OpenAIModule>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createMock } };
        },
        default: class {
            chat = { completions: { create: createMock } };
        },
    };
});

vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    encryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => v,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(async () => undefined),
}));

const selectResults = new Map<unknown, unknown[][]>();

function selectChain() {
    let table: unknown;
    const next = () => selectResults.get(table)?.shift() ?? [];
    const c = {
        from: (t: unknown) => {
            table = t;
            return c;
        },
        innerJoin: () => c,
        where: () => c,
        for: () => c,
        orderBy: () => c,
        limit: () => Promise.resolve(next()),
        // biome-ignore lint/suspicious/noThenProperty: mocks a thenable query builder
        then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(next()).then(resolve),
    };
    return c;
}

const tx = {
    select: () => selectChain(),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

vi.mock("@/db", () => ({
    db: {
        select: () => selectChain(),
        transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
}));

const REPLY = JSON.stringify({
    summary: "## Heading\n\n- one\n- two",
    keyPoints: ["a"],
    actionItems: [],
});

interface SummarySettings {
    summaryPrompt?: unknown;
    aiOutputLanguage?: string | null;
    detectedLanguage?: string | null;
    defaultTranscriptionLanguage?: string | null;
    summaryMultiPass?: boolean;
    summaryMultiPassRounds?: number;
}

async function summarize(
    settings: SummarySettings = {},
    presetId?: string,
    trigger: "manual" | "auto" = "manual",
) {
    profileLegacy.current = settings;
    selectResults.set(recordings, [
        [{ id: "rec-1", userId: "user-1", deletedAt: null }],
        [{ deletedAt: null }],
    ]);
    selectResults.set(transcriptions, [
        [
            {
                recordingId: "rec-1",
                userId: "user-1",
                source: "riffado",
                text: "a transcript",
                detectedLanguage: settings.detectedLanguage ?? null,
            },
        ],
    ]);
    selectResults.set(userSettings, [
        [
            {
                summaryPrompt: settings.summaryPrompt ?? null,
                aiOutputLanguage: settings.aiOutputLanguage ?? null,
                defaultTranscriptionLanguage:
                    settings.defaultTranscriptionLanguage ?? null,
                summaryMultiPass: settings.summaryMultiPass ?? false,
                summaryMultiPassRounds: settings.summaryMultiPassRounds ?? null,
                summaryMergePrompt: null,
            },
        ],
    ]);
    selectResults.set(apiCredentials, [
        [
            {
                apiKey: "enc-key",
                baseUrl: "",
                provider: "openai",
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
                userId: "user-1",
            },
        ],
    ]);
    selectResults.set(aiEnhancements, [[]]);

    createMock.mockResolvedValue({
        choices: [{ message: { content: REPLY } }],
    });

    return generateSummaryForRecording("user-1", "rec-1", {
        trigger,
        presetId,
    });
}

/** System messages from every provider call this run made. */
function systemMessages(): string[] {
    return createMock.mock.calls.map(
        (call) =>
            (call[0] as { messages: { role: string; content: string }[] })
                .messages[0].content,
    );
}

function userMessages(): string[] {
    return createMock.mock.calls.map(
        (call) =>
            (
                call[0] as { messages: { role: string; content: string }[] }
            ).messages.at(-1)?.content ?? "",
    );
}

describe("markdown formatting directive", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("reaches the model on the single-pass path", async () => {
        await summarize();
        expect(systemMessages()[0]).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
        expect(systemMessages()[0]).toContain(SUMMARY_SPEAKER_DIRECTIVE);
    });

    it.each([
        "manual",
        "auto",
    ] as const)("keeps the seeded English prompt on the %s path without a template", async (trigger) => {
        await summarize({}, undefined, trigger);
        expect(userMessages()[0]).toBe(
            assembleSummaryPrompt(SUMMARY_PROMPT_PARTS.general, "en").replace(
                "{transcription}",
                "a transcript",
            ),
        );
    });

    it("keeps a seeded custom prompt on the manual path without a template", async () => {
        await summarize({
            summaryPrompt: {
                selectedPrompt: "custom-1",
                customPrompts: [
                    {
                        id: "custom-1",
                        name: "Mine",
                        prompt: "My exact summary: {transcription}",
                        createdAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            },
        });
        expect(userMessages()[0]).toBe("My exact summary: a transcript");
    });

    it("uses the Czech built-in for Czech content without a template", async () => {
        await summarize({ detectedLanguage: "cs-CZ" });
        expect(userMessages()[0]).toBe(
            assembleSummaryPrompt(
                SUMMARY_PROMPT_PARTS.general,
                "cs-CZ",
            ).replace("{transcription}", "a transcript"),
        );
    });

    it("no longer forbids markdown outright", async () => {
        await summarize();
        // The exact wording that flattened every summary into a paragraph.
        expect(systemMessages()[0]).not.toContain("no markdown formatting");
    });

    it("forbids restating the key points inside the summary", async () => {
        // Both lists render directly beneath the summary. A summary that
        // repeats them as its own section shows everything twice, which is
        // the obvious failure mode of asking for more structure.
        await summarize();
        expect(systemMessages()[0]).toContain("rendered as their own lists");
    });

    it("caps headings at level 3, which is what the sidecar nests under", async () => {
        // `buildSummaryMarkdown` writes the summary under `## Summary`, so a
        // heading above level 3 inside it breaks the exported document's
        // hierarchy.
        await summarize();
        expect(systemMessages()[0]).toContain(
            "never open a heading above level 3",
        );
    });

    it("still demands a bare JSON object", async () => {
        await summarize();
        const system = systemMessages()[0];
        expect(system).toContain("JSON");
        expect(system).toContain("code fences");
    });

    it("reaches a prompt the user wrote themselves", async () => {
        // A custom prompt cannot be edited to mention Markdown, so the
        // directive has to be appended rather than baked into the presets.
        await summarize({
            summaryPrompt: {
                selectedPrompt: "custom-1",
                customPrompts: [
                    {
                        id: "custom-1",
                        name: "Mine",
                        prompt: "Summarize this: {transcription}",
                        createdAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            },
        });
        expect(systemMessages()[0]).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
    });

    it("rides along with the language directive rather than replacing it", async () => {
        await summarize({ aiOutputLanguage: "cs" });
        const system = systemMessages()[0];
        expect(system).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
        expect(system).toContain("Czech");
    });

    it("reaches the multi-pass merge, which rewrites the prose", async () => {
        await summarize({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        // Passes then merge: the merge is the last call, and it is the one
        // that would otherwise flatten the passes' Markdown.
        const messages = systemMessages();
        expect(messages.length).toBeGreaterThan(2);
        expect(messages.at(-1)).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
        expect(messages.at(-1)).toContain(SUMMARY_SPEAKER_DIRECTIVE);
    });

    it("tells every pass and the merge that the content is data, not instructions", async () => {
        await summarize({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        const messages = systemMessages();
        expect(messages.length).toBeGreaterThan(2);
        for (const message of messages) {
            expect(message).toContain(CONTENT_IS_DATA_DIRECTIVE);
        }
    });

    it("forbids guessed identities and specifies stable placeholders", async () => {
        await summarize();
        const system = systemMessages()[0];
        expect(system).toContain("Never infer, guess, or invent");
        expect(system).toContain("[Speaker N](#speaker-N)");
        expect(system).toContain("summary, keyPoints, and actionItems");
    });
});

/**
 * Every prompt is written in English, so "auto" used to mean "no language
 * instruction at all" -- and a Czech transcript came back in English, or in
 * Czech under the English "###" headings the preset named.
 */
describe("output language under auto", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("tells a pass to write in the transcription's language, headings included", async () => {
        await summarize({ aiOutputLanguage: null });
        const system = systemMessages()[0];
        expect(system).toContain(
            "the language the transcription is predominantly spoken in",
        );
        expect(system).toContain("every heading, label, and example wording");
    });

    it("treats an explicit auto the same as no preference", async () => {
        await summarize({ aiOutputLanguage: "auto" });
        expect(systemMessages()[0]).toContain(
            "the language the transcription is predominantly spoken in",
        );
    });

    it("points the merge at the passes, since it never sees the transcript", async () => {
        await summarize({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        const messages = systemMessages();
        expect(messages[0]).toContain(
            "the language the transcription is predominantly spoken in",
        );
        expect(messages.at(-1)).toContain(
            "the language the extractions are written in",
        );
    });

    it("keeps the English speaker placeholders the resolver matches on", async () => {
        await summarize();
        expect(systemMessages()[0]).toContain(
            "keep speaker references such as [Speaker 1](#speaker-1) exactly as written",
        );
    });

    it("gives way to a language the user chose", async () => {
        await summarize({
            aiOutputLanguage: "cs",
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
        });
        for (const system of systemMessages()) {
            expect(system).toContain(
                "Write all natural-language output in Czech",
            );
            expect(system).not.toContain("predominantly spoken in");
            expect(system).not.toContain("the extractions are written in");
        }
    });

    it("translates the preset's headings into a chosen language too", async () => {
        // A chosen language had the same gap as auto: "Write in Czech" alone
        // left the preset's English "### Attendees" in place, and said
        // nothing to stop [Speaker 1] from being translated out of the form
        // the resolver matches on.
        await summarize({
            aiOutputLanguage: "cs",
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
        });
        for (const system of systemMessages()) {
            expect(system).toContain(
                "every heading, label, and example wording",
            );
            expect(system).toContain(
                "keep speaker references such as [Speaker 1](#speaker-1) exactly as written",
            );
            // The escape hatch for a custom prompt naming its own language
            // belongs to auto only: a chosen language is the user's word.
            expect(system).not.toContain("Follow a different output language");
        }
    });

    it("uses thematic Czech minutes for the legacy meeting prompt under auto", async () => {
        await summarize({ detectedLanguage: "cs-CZ" }, "meeting-notes");
        expect(systemMessages()[0]).toContain(
            "the language the transcription is predominantly spoken in",
        );
        expect(userMessages()[0]).toContain("Nejprve z této schůzky");
        expect(userMessages()[0]).toContain("350–700");
        expect(userMessages()[0]).not.toContain("Účastníci, Účel, Diskuse");
        expect(userMessages()[0]).toContain("skutečně probíraných témat");
    });

    it("uses the transcription language setting when the provider returned none", async () => {
        await summarize(
            { defaultTranscriptionLanguage: "cs" },
            "meeting-notes",
        );
        expect(userMessages()[0]).toContain("skutečně probíraných témat");
    });

    it("keeps account-language prompt wording with a generic directive when detection returned none", async () => {
        await summarize({ defaultTranscriptionLanguage: "cs" });
        expect(systemMessages()[0]).toContain(
            "the language the transcription is predominantly spoken in",
        );
        expect(userMessages()[0]).toContain(
            "Nejprve z tohoto zvukového přepisu",
        );
    });

    it("recognizes a provider's language name", async () => {
        await summarize({ detectedLanguage: "Czech" }, "meeting-notes");
        expect(userMessages()[0]).toContain("skutečně probíraných témat");
    });

    it("lets an explicit output language override the detected language", async () => {
        await summarize(
            { detectedLanguage: "cs", aiOutputLanguage: "en" },
            "meeting-notes",
        );
        expect(systemMessages()[0]).toContain("output in English");
        expect(userMessages()[0]).toContain(
            "named after the actual topics in the output language",
        );
    });

    it("preserves an edited meeting template", async () => {
        await summarize(
            {
                detectedLanguage: "cs",
                summaryPrompt: {
                    selectedPrompt: "meeting-notes",
                    templates: [
                        {
                            id: "meeting-notes",
                            name: null,
                            prompt: "My meeting template: {transcription}",
                            createdAt: "2026-01-01T00:00:00.000Z",
                        },
                    ],
                },
            },
            "meeting-notes",
        );
        expect(userMessages()[0]).toContain(
            "My meeting template: a transcript",
        );
        expect(userMessages()[0]).not.toContain("Účastníci");
    });
});

describe("markdown content survives the parser", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("keeps headings and bullets in the stored summary", async () => {
        const result = await summarize();
        expect(result.summary).toBe("## Heading\n\n- one\n- two");
    });
});
