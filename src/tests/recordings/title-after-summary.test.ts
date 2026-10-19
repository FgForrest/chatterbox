import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    applyGeneratedTitle: vi.fn(),
    emitEvent: vi.fn(),
    limit: vi.fn(),
    markAutomaticTitleSkipped: vi.fn(),
    readProcessing: vi.fn(),
    resolveItemProfile: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: () => {
            const chain = {
                from: () => chain,
                leftJoin: () => chain,
                where: () => chain,
                limit: mocks.limit,
            };
            return chain;
        },
    },
}));
vi.mock("@/lib/pipeline/state", () => ({
    markAutomaticTitleSkipped: mocks.markAutomaticTitleSkipped,
    readProcessing: mocks.readProcessing,
}));
vi.mock("@/lib/recordings/apply-generated-title", () => ({
    applyGeneratedTitle: mocks.applyGeneratedTitle,
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));

import { updateTitleAfterSummary } from "@/lib/recordings/title-after-summary";

const fence = {
    contentId: "transcript-1",
    contentSourceId: "riffado",
    contentRevision: 2,
    profileRevisionId: "profile-revision-1",
};
const input = {
    userId: "user-1",
    recordingId: "rec-1",
    summary: "The group planned the quarterly launch.",
    keyPoints: ["The launch is in November."],
    fence,
};

describe("title after summary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readProcessing.mockResolvedValue({ phases: {} });
        mocks.resolveItemProfile.mockResolvedValue({
            assigned: true,
            revisionId: "profile-revision-1",
            settings: { steps: { title: { automatic: true } } },
        });
        mocks.limit
            .mockResolvedValueOnce([
                {
                    kind: "audio",
                    plaudFileId: "plaud-1",
                    titleEditedAt: null,
                },
            ])
            .mockResolvedValueOnce([{ syncTitleToPlaud: false }]);
        mocks.applyGeneratedTitle.mockResolvedValue(true);
        mocks.markAutomaticTitleSkipped.mockResolvedValue(true);
    });

    it("generates the first automatic title from the completed summary", async () => {
        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            text: "The group planned the quarterly launch.\nThe launch is in November.",
            source: "summary",
            kind: "audio",
            plaudFileId: "plaud-1",
            syncTitleToPlaud: false,
            fence,
            skipIfAutomaticTitleSettled: true,
        });
        expect(mocks.emitEvent).toHaveBeenCalledWith(
            "recording.updated",
            "user-1",
            "rec-1",
        );
    });

    it("does not generate again after the automatic title step is done", async () => {
        mocks.readProcessing.mockResolvedValue({
            phases: {
                summary: {
                    steps: { title: { state: "done" } },
                },
            },
        });

        await updateTitleAfterSummary(input);

        expect(mocks.resolveItemProfile).not.toHaveBeenCalled();
        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
    });

    it("records a hand-edited title as permanently protected", async () => {
        mocks.limit.mockReset();
        mocks.limit.mockResolvedValueOnce([
            {
                kind: "audio",
                plaudFileId: "plaud-1",
                titleEditedAt: new Date(),
            },
        ]);

        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.markAutomaticTitleSkipped).toHaveBeenCalledWith({
            itemId: "rec-1",
            userId: "user-1",
            content: fence,
            reason: "first_summary_title_edited",
        });
    });

    it("settles the title decision when profile title automation is off", async () => {
        mocks.resolveItemProfile.mockResolvedValue({
            assigned: true,
            revisionId: "profile-revision-1",
            settings: { steps: { title: { automatic: false } } },
        });

        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
        expect(mocks.markAutomaticTitleSkipped).toHaveBeenCalledWith({
            itemId: "rec-1",
            userId: "user-1",
            content: fence,
            reason: "first_summary_title_disabled",
        });
    });

    it("closes a failed attempt without settling the title", async () => {
        mocks.applyGeneratedTitle.mockResolvedValue(false);

        await updateTitleAfterSummary(input);

        expect(mocks.markAutomaticTitleSkipped).toHaveBeenCalledWith({
            itemId: "rec-1",
            userId: "user-1",
            content: fence,
            reason: "first_summary_title_failed",
        });
    });

    it.each([
        "first_summary_title_disabled",
        "first_summary_title_edited",
    ])("does not try again once the title settled as %s", async (reason) => {
        mocks.readProcessing.mockResolvedValue({
            phases: {
                summary: { steps: { title: { state: "skipped", reason } } },
            },
        });

        await updateTitleAfterSummary(input);

        expect(mocks.resolveItemProfile).not.toHaveBeenCalled();
        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
    });

    it("tries again at the next summary after a failed attempt", async () => {
        mocks.readProcessing.mockResolvedValue({
            phases: {
                summary: {
                    steps: {
                        title: {
                            state: "skipped",
                            reason: "first_summary_title_failed",
                        },
                    },
                },
            },
        });

        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).toHaveBeenCalledOnce();
    });

    it("still records the failure when the title provider throws", async () => {
        mocks.applyGeneratedTitle.mockRejectedValue(new Error("provider down"));

        await expect(updateTitleAfterSummary(input)).rejects.toThrow(
            "provider down",
        );
        expect(mocks.markAutomaticTitleSkipped).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "first_summary_title_failed" }),
        );
    });

    it("applies the same first-summary rule when mail title automation is enabled", async () => {
        mocks.limit.mockReset();
        mocks.limit.mockResolvedValueOnce([
            { kind: "mail", plaudFileId: null, titleEditedAt: null },
        ]);

        await updateTitleAfterSummary(input);

        expect(mocks.applyGeneratedTitle).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "mail",
                source: "summary",
                syncTitleToPlaud: false,
            }),
        );
        expect(mocks.limit).toHaveBeenCalledTimes(1);
    });
});
