import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    create: vi.fn(),
    openAi: vi.fn(),
    select: vi.fn(),
    resolveItemProfile: vi.fn(),
    resolveStepProvider: vi.fn(),
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

    it("generates a manual title when automatic titles are off", async () => {
        selectRows([{ detectedLanguage: "cs" }]);
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
            "the language the transcription is predominantly spoken in",
        );
        expect(request.messages[1].content).toContain("Jste generátor názvů");
    });
});
