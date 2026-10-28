import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    chatterItems,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import {
    explicitAiOutputLanguage,
    getAiOutputLanguageDirective,
} from "@/lib/ai/summary-presets";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";

const mocks = vi.hoisted(() => ({
    create: vi.fn<
        (params: ChatCompletionCreateParamsNonStreaming) => Promise<unknown>
    >(),
    rows: new Map<unknown, unknown[]>(),
    profile: vi.fn(),
    provider: vi.fn(),
    context: vi.fn(),
    persist: vi.fn(),
    content: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: () => {
            let table: unknown;
            const rows = () => Promise.resolve(mocks.rows.get(table) ?? []);
            const query = {
                from: (value: unknown) => {
                    table = value;
                    return query;
                },
                innerJoin: () => query,
                where: () => query,
                orderBy: () => query,
                limit: rows,
                // biome-ignore lint/suspicious/noThenProperty: Drizzle queries are awaitable
                then: (resolve: (value: unknown[]) => unknown) =>
                    rows().then(resolve),
            };
            return query;
        },
    },
}));
vi.mock("openai", () => ({
    OpenAI: class {
        chat = { completions: { create: mocks.create } };
    },
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.profile,
    loadSelectedProfileRevision: mocks.profile,
}));
vi.mock("@/lib/profiles/resolve-manual", () => ({
    resolveManualItemProfile: mocks.profile,
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: mocks.provider,
}));
vi.mock("@/lib/sharing/run-context", () => ({
    resolveRunContext: mocks.context,
}));
vi.mock("@/lib/sharing/writer", () => ({
    contentWriterRefusalNow: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/sharing/notify", () => ({ notifyIfShared: vi.fn() }));
vi.mock("@/lib/pipeline/driver", () => ({
    pipelineDriver: () => ({ view: "private" }),
}));
vi.mock("@/lib/pipeline/state", () => ({
    readProcessing: vi
        .fn()
        .mockResolvedValue({ profileRevisionId: "profile-revision" }),
}));
vi.mock("@/lib/tasks/access", () => ({ taskViewerById: vi.fn() }));
vi.mock("@/lib/tasks/proposals", () => ({
    loadTasksPromptContext: vi
        .fn()
        .mockResolvedValue({ text: "", refs: new Map() }),
    resolveTaskProposals: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/summary/read-summary", () => ({
    readPlaudActionItems: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/transcription/persist", () => ({
    upsertEnhancement: mocks.persist,
}));
vi.mock("@/lib/learn/llm-input", () => ({
    modelInput: async (transcript: { text: string }) => ({
        text: transcript.text,
        turns: null,
        fingerprint: "transcript-fingerprint",
    }),
}));
vi.mock("@/lib/content/read-item-content", () => ({
    readItemContent: mocks.content,
}));
vi.mock("@/lib/mail/redact", () => ({
    maskedContentForModel: async (content: unknown) => content,
    secretAddressMasker: async () => (text: string) => text,
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
    decryptJsonField: (value: unknown) => value,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(),
}));
vi.mock("@/lib/ai/usage-cost", () => ({ recordChatCompletionUsage: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));

const transcriptText = "Zítra pošlu návrh smlouvy. Termín potvrdíme v pátek.";

function stage(
    kind: "audio" | "mail",
    preference: string | null | undefined,
    view: "private" | "org" = "private",
    multiPass = false,
) {
    const settings = defaultProfileSettings(kind);
    settings.steps.summary.outputLanguage = preference ?? "auto";
    mocks.profile.mockResolvedValue({
        settings,
        revisionId: "profile-revision",
    });
    mocks.context.mockResolvedValue({
        view,
        actorUserId: "actor",
        ownerUserId: "owner",
        contentUserId: "owner",
        settingsUserId: view === "org" ? "organization" : "owner",
        actsForOrganization: view === "org",
    });
    mocks.rows.set(chatterItems, [
        {
            kind,
            id: "item",
            userId: "owner",
            title: "Termín smlouvy",
            sentAt: new Date("2026-10-20T10:00:00Z"),
        },
    ]);
    mocks.rows.set(recordings, [{ id: "item", userId: "owner" }]);
    mocks.rows.set(transcriptions, [
        {
            id: "transcript",
            source: "riffado",
            revision: 1,
            detectedLanguage: "hun",
            text: transcriptText,
        },
    ]);
    mocks.rows.set(users, [{ uiLocale: "cs-CZ" }]);
    mocks.rows.set(userSettings, [
        {
            aiOutputLanguage: preference,
            defaultTranscriptionLanguage: "hu",
            summaryMultiPass: multiPass,
            summaryMultiPassRounds: 2,
        },
    ]);
    mocks.content.mockResolvedValue({
        sourceId: "mail-content",
        revision: 1,
        language: "hun",
        participants: [],
        segments: [{ index: 0, role: "body", text: transcriptText }],
    });
}

function systemPrompts(): string[] {
    return mocks.create.mock.calls.map(([request]) => {
        const content = request.messages.find(
            (message) => message.role === "system",
        )?.content;
        if (typeof content !== "string")
            throw new Error("Missing system prompt");
        return content;
    });
}

describe("auto output language ignores an incorrect provider detection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.rows.clear();
        mocks.provider.mockResolvedValue({
            kind: "credential",
            credential: {
                id: "credential",
                provider: "Custom",
                apiKey: "test-key",
                baseUrl: "https://ai.example.test/v1",
                defaultModel: "test-model",
            },
            payerUserId: "actor",
            reserveCall: vi.fn().mockResolvedValue(undefined),
            organizationCredential: false,
        });
        mocks.persist.mockResolvedValue({ committed: true });
        mocks.create.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "Návrh smlouvy bude odeslán zítra.",
                            keyPoints: [],
                            actionItems: [],
                        }),
                    },
                },
            ],
        });
    });

    it.each([
        "auto",
        null,
        undefined,
        "cs",
    ])("resolves only the explicit output preference %s", (preference) => {
        expect(explicitAiOutputLanguage(preference)).toBe(
            preference === "cs" ? "cs" : null,
        );
    });

    describe.each(["audio", "mail"] as const)("%s summaries", (kind) => {
        it.each([
            "private",
            "org",
        ] as const)("uses generic pass and merge directives and persists null in the %s view", async (view) => {
            stage(kind, "auto", view, true);
            const result = await generateSummaryForRecording("actor", "item", {
                view,
            });

            expect(result.multiPass?.merged).toBe(true);
            const systems = systemPrompts();
            expect(systems).toHaveLength(3);
            for (const system of systems.slice(0, 2)) {
                expect(system).toContain(getAiOutputLanguageDirective(null));
                expect(system).toContain("predominantly spoken");
            }
            expect(systems[2]).toContain(
                getAiOutputLanguageDirective(null, "extractions"),
            );
            for (const system of systems)
                expect(system).not.toContain("Hungarian");
            expect(mocks.persist).toHaveBeenCalledWith(
                expect.objectContaining({
                    outputLanguage: null,
                    inputs: expect.objectContaining({
                        contentSourceId: kind === "mail" ? "mail" : "riffado",
                        contentRevision: 1,
                    }),
                }),
            );
            expect(mocks.persist.mock.calls[0]?.[0].inputs).not.toHaveProperty(
                "outputLanguage",
            );
        });

        it("honors an explicit Czech profile output language", async () => {
            stage(kind, "cs", "private", true);
            await generateSummaryForRecording("actor", "item");

            expect(systemPrompts()).toHaveLength(3);
            for (const system of systemPrompts()) {
                expect(system).toContain(getAiOutputLanguageDirective("cs"));
            }
            expect(mocks.persist).toHaveBeenCalledWith(
                expect.objectContaining({ outputLanguage: "cs" }),
            );
        });

        it.each([
            "auto",
            null,
            undefined,
            "cs",
        ])("honors the legacy preference %s on the single-pass path", async (preference) => {
            stage(kind, preference);
            await generateSummaryForRecording("actor", "item", {
                presetId: "general",
            });

            expect(systemPrompts()).toHaveLength(1);
            const expected = preference === "cs" ? "cs" : null;
            expect(systemPrompts()[0]).toContain(
                getAiOutputLanguageDirective(expected),
            );
            expect(systemPrompts()[0]).not.toContain("Hungarian");
            expect(mocks.persist).toHaveBeenCalledWith(
                expect.objectContaining({ outputLanguage: expected }),
            );
        });
    });

    it.each([
        "auto",
        "cs",
    ])("uses the %s preference for titles", async (preference) => {
        stage("audio", preference);
        mocks.create.mockResolvedValue({
            choices: [{ message: { content: "Návrh smlouvy" } }],
        });

        await expect(
            generateTitleFromTranscription(
                "actor",
                "item",
                transcriptText,
                "transcript",
                "owner",
                "private",
                "hun",
            ),
        ).resolves.toBe("Návrh smlouvy");

        expect(systemPrompts()).toHaveLength(1);
        expect(systemPrompts()[0]).toContain(
            getAiOutputLanguageDirective(preference === "cs" ? "cs" : null),
        );
        expect(systemPrompts()[0]).not.toContain("Hungarian");
    });
});
