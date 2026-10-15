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

import { readTitleInput } from "@/lib/recordings/title-input";

describe("title input", () => {
    beforeEach(() => vi.clearAllMocks());

    it("uses the complete summary before the transcript", async () => {
        mocks.readStoredSummary.mockResolvedValue({
            summary: "The group planned the quarterly launch.",
            keyPoints: ["The launch is in November."],
        });

        expect(await readTitleInput("user-1", "rec-1")).toEqual({
            source: "summary",
            text: "The group planned the quarterly launch.\nThe launch is in November.",
        });
        expect(mocks.limit).not.toHaveBeenCalled();
    });

    it("uses the corrected transcript when no summary exists", async () => {
        mocks.readStoredSummary.mockResolvedValue(null);
        mocks.limit.mockResolvedValue([{ id: "transcript-1" }]);
        mocks.modelInput.mockResolvedValue({ text: "Corrected launch plan" });

        expect(await readTitleInput("user-1", "rec-1")).toEqual({
            source: "transcript",
            text: "Corrected launch plan",
        });
        expect(mocks.modelInput).toHaveBeenCalledWith({ id: "transcript-1" });
    });
});
