import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    applyGeneratedTitle: vi.fn(),
    emitEvent: vi.fn(),
    isHeldForLearn: vi.fn(),
    readTitleInput: vi.fn(),
    resolveItemProfile: vi.fn(),
    select: vi.fn(),
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
            const chain = {
                from: () => chain,
                innerJoin: () => chain,
                leftJoin: () => chain,
                where: () => chain,
                limit: () =>
                    Promise.resolve(
                        recording
                            ? [
                                  {
                                      kind: "audio",
                                      plaudFileId: "plaud-1",
                                      titleEditedAt: null,
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
});
