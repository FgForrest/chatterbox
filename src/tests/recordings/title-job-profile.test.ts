import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    applyGeneratedTitle: vi.fn(),
    emitEvent: vi.fn(),
    isHeldForLearn: vi.fn(),
    readTitleInput: vi.fn(),
    resolveItemProfile: vi.fn(),
    select: vi.fn(),
    processing: {
        phases: {} as Record<string, unknown>,
        profileRevisionId: null as string | null,
    },
}));

vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/learn/hold", () => ({
    isHeldForLearn: mocks.isHeldForLearn,
}));
vi.mock("@/lib/profiles/resolve", () => ({
    resolveItemProfile: mocks.resolveItemProfile,
}));
vi.mock("@/lib/recordings/apply-generated-title", () => ({
    applyGeneratedTitle: mocks.applyGeneratedTitle,
}));
vi.mock("@/lib/recordings/title-input", () => ({
    readTitleInput: mocks.readTitleInput,
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));

import { titleJobHandler } from "@/lib/recordings/title-job-handler";

function context() {
    return {
        jobId: "job-1",
        userId: "user-1",
        attempt: 1,
        maxAttempts: 3,
        payload: { recordingId: "recording-1" },
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
    };
}

describe("title job profile switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isHeldForLearn.mockResolvedValue(false);
        mocks.select.mockImplementation((fields: Record<string, unknown>) => {
            const recording = "plaudFileId" in fields;
            const processing = "phases" in fields;
            const chain = {
                from: () => chain,
                innerJoin: () => chain,
                leftJoin: () => chain,
                where: () => chain,
                limit: () =>
                    Promise.resolve(
                        processing
                            ? [mocks.processing]
                            : recording
                              ? [
                                    {
                                        kind: "audio",
                                        plaudFileId: "plaud-1",
                                        titleEditedAt: null,
                                        phases: mocks.processing.phases,
                                        profileRevisionId:
                                            mocks.processing.profileRevisionId,
                                    },
                                ]
                              : [{ syncTitleToPlaud: false }],
                    ),
            };
            return chain;
        });
        mocks.readTitleInput.mockResolvedValue({
            source: "summary",
            text: "Quarterly launch",
        });
        mocks.applyGeneratedTitle.mockResolvedValue(true);
        mocks.processing.phases = {};
        mocks.processing.profileRevisionId = null;
    });

    it.each([
        { automatic: true, calls: 1 },
        { automatic: false, calls: 0 },
    ])("generates $calls title when automatic is $automatic", async ({
        automatic,
        calls,
    }) => {
        mocks.resolveItemProfile.mockResolvedValue({
            settings: { steps: { title: { automatic } } },
        });

        await titleJobHandler.run(context());

        expect(mocks.applyGeneratedTitle).toHaveBeenCalledTimes(calls);
        expect(mocks.emitEvent).toHaveBeenCalledTimes(calls);
    });

    it("skips a queued title already completed for the same fence", async () => {
        mocks.resolveItemProfile.mockResolvedValue({
            assigned: true,
            revisionId: "profile-revision-1",
            settings: { steps: { title: { automatic: true } } },
        });
        mocks.readTitleInput.mockResolvedValue({
            source: "summary",
            text: "Quarterly launch",
            fence: {
                contentId: "summary-source-1",
                contentSourceId: "riffado",
                contentRevision: 2,
                profileRevisionId: "profile-revision-1",
            },
        });
        mocks.processing.profileRevisionId = "profile-revision-1";
        mocks.processing.phases = {
            summary: {
                state: "done",
                generation: 4,
                at: "2026-10-16T00:00:00.000Z",
                inputs: {
                    contentId: "summary-source-1",
                    contentSourceId: "riffado",
                    contentRevision: 2,
                },
                steps: {
                    title: {
                        contentId: "summary-source-1",
                        contentSourceId: "riffado",
                        contentRevision: 2,
                        profileRevisionId: "profile-revision-1",
                        generation: 4,
                        state: "done",
                    },
                },
            },
        };

        expect(await titleJobHandler.run(context())).toEqual({
            skipped: "done",
        });
        expect(mocks.applyGeneratedTitle).not.toHaveBeenCalled();
    });
});
