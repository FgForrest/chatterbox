import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    create: vi.fn(),
    openAi: vi.fn(),
    select: vi.fn(),
    resolveItemProfile: vi.fn(),
    confirmedLanguage: vi.fn(),
    resolveStepProvider: vi.fn(),
}));

vi.mock("@/lib/recordings/read-language", () => ({
    readConfirmedLanguage: mocks.confirmedLanguage,
}));

vi.mock("openai", () => ({
    OpenAI: function OpenAI(options: unknown) {
        mocks.openAi(options);
        return { chat: { completions: { create: mocks.create } } };
    },
}));
vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));
vi.mock("@/lib/profiles/providers", () => ({
    resolveStepProvider: mocks.resolveStepProvider,
}));
vi.mock("@/lib/ai/usage-cost", () => ({
    recordChatCompletionUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { defaultProfileSettings } from "@/lib/profiles/settings";

function selectRows(rows: unknown[]) {
    mocks.select.mockReturnValueOnce({
        from: () => ({
            where: () => ({ limit: () => Promise.resolve(rows) }),
        }),
    });
}

describe("profile-backed title generation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.confirmedLanguage.mockResolvedValue(null);
        const settings = defaultProfileSettings("audio");
        settings.steps.title.automatic = false;
        mocks.resolveItemProfile.mockResolvedValue({
            settings,
        });
        mocks.resolveStepProvider.mockResolvedValue({
            kind: "credential",
            credential: {
                id: "credential-1",
                provider: "OpenAI",
                apiKey: "secret",
                baseUrl: null,
                defaultModel: "gpt-4o-mini",
            },
            payerUserId: "owner-1",
            reserveCall: vi.fn().mockResolvedValue(undefined),
            organizationCredential: false,
        });
        mocks.create.mockResolvedValue({
            choices: [{ message: { content: "Název" } }],
        });
    });

    it.each([
        "riffado",
        "mixed",
        "plaud",
    ])("uses a generic language directive and Czech prompt wording for ces from %s", async (source) => {
        selectRows([{ source, detectedLanguage: "ces" }]);
        selectRows([{ uiLocale: "cs-CZ" }]);

        await generateTitleFromTranscription(
            "actor-1",
            "recording-1",
            "Přepis nahrávky",
            "transcript",
            "owner-1",
        );

        const request = mocks.create.mock.calls[0]?.[0];
        expect(request.messages[0].content).toContain(
            "Write all natural-language output in the language the transcription is predominantly spoken in",
        );
        expect(request.messages[0].content).toContain(
            "Use English Title Case only for English; Czech and most other European languages use sentence case.",
        );
        expect(request.messages[1].content).toContain("Jste generátor názvů");
    });

    it.each([
        "private",
        "org",
    ] as const)("uses the owner’s confirmed language in %s", async (view) => {
        selectRows([{ uiLocale: "en" }]);
        mocks.confirmedLanguage.mockResolvedValue("cs");
        await generateTitleFromTranscription(
            "actor-1",
            "recording-1",
            "Text",
            "transcript",
            "owner-1",
            view,
            "hun",
        );
        expect(mocks.confirmedLanguage).toHaveBeenCalledWith(
            "owner-1",
            "recording-1",
        );
        expect(mocks.create.mock.calls[0]?.[0].messages[0].content).toContain(
            "Write all natural-language output in Czech",
        );
    });

    it("explicit title output wins over the recording language", async () => {
        selectRows([{ uiLocale: "en" }]);
        mocks.confirmedLanguage.mockResolvedValue("cs");
        const settings = defaultProfileSettings("audio");
        settings.steps.summary.outputLanguage = "en";
        mocks.resolveItemProfile.mockResolvedValue({ settings });
        await generateTitleFromTranscription(
            "actor-1",
            "recording-1",
            "Text",
            "transcript",
            "owner-1",
            "private",
            "hun",
        );
        expect(mocks.create.mock.calls[0]?.[0].messages[0].content).toContain(
            "Write all natural-language output in English",
        );
    });

    it("fails loudly when an explicit account title provider is disabled", async () => {
        selectRows([{ source: "riffado", detectedLanguage: "cs" }]);
        selectRows([{ uiLocale: "cs-CZ" }]);
        const error = new Error(
            "The provider OpenAI is disabled. Enable it or choose another provider.",
        );
        mocks.resolveStepProvider.mockRejectedValueOnce(error);

        await expect(
            generateTitleFromTranscription(
                "actor-1",
                "recording-1",
                "Přepis nahrávky",
                "transcript",
                "owner-1",
            ),
        ).rejects.toBe(error);
    });

    it("logs the provider id when automatic title generation has no model", async () => {
        selectRows([{ source: "riffado", detectedLanguage: "en" }]);
        selectRows([{ uiLocale: "en" }]);
        mocks.resolveStepProvider.mockResolvedValueOnce({
            kind: "credential",
            credential: {
                id: "credential-without-model",
                provider: "Custom",
                apiKey: "secret",
                baseUrl: "https://example.com/v1",
                defaultModel: null,
            },
            payerUserId: "owner-1",
            reserveCall: vi.fn().mockResolvedValue(undefined),
            organizationCredential: false,
        });
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        await expect(
            generateTitleFromTranscription(
                "actor-1",
                "recording-1",
                "Transcript",
                "transcript",
                "owner-1",
            ),
        ).resolves.toBeNull();
        expect(consoleError).toHaveBeenCalledWith(
            "Error generating title with provider credential-without-model:",
            expect.objectContaining({
                message:
                    "Set a Default Model on Custom in Settings > Providers.",
            }),
        );
        consoleError.mockRestore();
    });
});
