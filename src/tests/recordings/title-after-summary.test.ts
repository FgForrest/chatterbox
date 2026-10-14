import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    limit: vi.fn(),
    titleStillGenerated: vi.fn(),
    applyGeneratedTitle: vi.fn(),
    emitEvent: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({ where: () => ({ limit: mocks.limit }) }),
        }),
    },
}));
vi.mock("@/lib/recordings/generated-title", () => ({
    titleStillGenerated: mocks.titleStillGenerated,
}));
vi.mock("@/lib/recordings/apply-generated-title", () => ({
    applyGeneratedTitle: mocks.applyGeneratedTitle,
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));

import { updateTitleAfterSummary } from "@/lib/recordings/title-after-summary";

const input = {
    userId: "user-1",
    recordingId: "rec-1",
    summary: "The group planned the quarterly launch.",
    keyPoints: ["The launch is in November."],
};

describe("title after summary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.limit
            .mockResolvedValueOnce([
                { autoGenerateTitle: true, syncTitleToPlaud: false },
            ])
            .mockResolvedValueOnce([{ plaudFileId: "plaud-1" }]);
        mocks.titleStillGenerated.mockResolvedValue(true);
        mocks.applyGeneratedTitle.mockResolvedValue(true);
    });

    it("retitles from the completed summary and announces the change", async () => {
        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            text: "The group planned the quarterly launch.\nThe launch is in November.",
            source: "summary",
            plaudFileId: "plaud-1",
            syncTitleToPlaud: false,
        });
        expect(mocks.emitEvent).toHaveBeenCalledWith(
            "recording.updated",
            "user-1",
            "rec-1",
        );
    });

    it("preserves a title a person edited", async () => {
        mocks.titleStillGenerated.mockResolvedValue(false);

        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.emitEvent).not.toHaveBeenCalled();
    });
});
