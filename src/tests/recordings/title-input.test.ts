import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    readStoredSummary: vi.fn(),
    modelInput: vi.fn(),
    limit: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({ where: () => ({ limit: mocks.limit }) }),
        }),
    },
}));
vi.mock("@/lib/summary/read-summary", () => ({
    readStoredSummary: mocks.readStoredSummary,
}));
vi.mock("@/lib/learn/llm-input", () => ({ modelInput: mocks.modelInput }));
vi.mock("@/lib/content/read-item-content", () => ({
    readItemContent: vi.fn(),
}));
vi.mock("@/lib/content/render-mail", () => ({ renderMailForModel: vi.fn() }));
vi.mock("@/lib/encryption/fields", () => ({ decryptText: vi.fn() }));
vi.mock("@/lib/mail/redact", () => ({ maskedContentForModel: vi.fn() }));

import { readTitleInput } from "@/lib/recordings/title-input";

describe("title input", () => {
    beforeEach(() => vi.clearAllMocks());

    it("uses the complete summary before the transcript", async () => {
        mocks.readStoredSummary.mockResolvedValue({
            summary: "The group planned the quarterly launch.",
            keyPoints: ["The launch is in November."],
            transcriptionId: "transcript-1",
        });
        mocks.limit.mockResolvedValueOnce([{ detectedLanguage: "ces" }]);

        expect(await readTitleInput("user-1", "rec-1")).toEqual({
            source: "summary",
            text: "The group planned the quarterly launch.\nThe launch is in November.",
            contentLanguage: "ces",
        });
        expect(mocks.limit).toHaveBeenCalledOnce();
    });

    it("uses the corrected transcript when no summary exists", async () => {
        mocks.readStoredSummary.mockResolvedValue(null);
        mocks.limit.mockResolvedValue([
            { id: "transcript-1", source: "riffado", detectedLanguage: "ces" },
        ]);
        mocks.modelInput.mockResolvedValue({ text: "Corrected launch plan" });

        expect(await readTitleInput("user-1", "rec-1")).toEqual({
            source: "transcript",
            text: "Corrected launch plan",
            contentLanguage: "ces",
        });
        expect(mocks.modelInput).toHaveBeenCalledWith({
            id: "transcript-1",
            source: "riffado",
            detectedLanguage: "ces",
        });
    });
});
